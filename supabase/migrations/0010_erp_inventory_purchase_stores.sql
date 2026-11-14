-- MAX ERP: inventory, purchase and stores (first release).
-- Follows StockPilot PLAN.md: item code format, one stock UOM per item,
-- stock held per item x unit x bucket, ledger is append-only, no negative stock,
-- creator of a PO cannot release it.

create extension if not exists pgcrypto;

-- ---------- Masters ----------
create table if not exists public.uom (
  code text primary key,
  name text not null
);

create table if not exists public.item (
  id uuid primary key default gen_random_uuid(),
  item_code text not null unique
    check (item_code ~ '^\d{2}-\d{3}-\d{2}-\d{2}-\d{2}$'),
  short_name varchar(31) not null,
  description text,
  stock_uom text not null references public.uom(code),
  purchase_uom text references public.uom(code),
  conversion_factor numeric(14,3) not null default 1 check (conversion_factor > 0),
  item_type text not null check (item_type in ('RM','BOP','SFG','FG','Consumable')),
  safety_stock numeric(14,3) not null default 0 check (safety_stock >= 0),
  moq numeric(14,3) not null default 0 check (moq >= 0),
  is_active boolean not null default true,
  created_at timestamptz not null default now()
);

create table if not exists public.bom_header (
  id uuid primary key default gen_random_uuid(),
  fg_item_id uuid not null references public.item(id),
  version int not null default 1 check (version > 0),
  is_active boolean not null default true,
  unique (fg_item_id, version)
);

create table if not exists public.bom_line (
  id uuid primary key default gen_random_uuid(),
  bom_id uuid not null references public.bom_header(id) on delete cascade,
  component_item_id uuid not null references public.item(id),
  qty_per numeric(14,3) not null check (qty_per > 0),
  scrap_pct numeric(5,2) not null default 0 check (scrap_pct >= 0)
);

create table if not exists public.vendor (
  id uuid primary key default gen_random_uuid(),
  vendor_code text not null unique,
  name text not null,
  gstin text,
  address text,
  payment_terms text,
  is_active boolean not null default true
);

-- ---------- Purchase ----------
create table if not exists public.purchase_order (
  id uuid primary key default gen_random_uuid(),
  po_no text not null unique,
  vendor_id uuid not null references public.vendor(id),
  unit text not null,
  status text not null default 'Draft'
    check (status in ('Draft','Pending verification','Verified','Released','Cancelled','Closed')),
  po_date date not null default current_date,
  created_by uuid not null default auth.uid(),
  verified_by uuid,
  released_by uuid,
  created_at timestamptz not null default now(),
  -- PLAN.md golden rule 8: the creator of a PO cannot release it
  constraint po_creator_cannot_release check (released_by is null or released_by <> created_by)
);

create table if not exists public.po_line (
  id uuid primary key default gen_random_uuid(),
  po_id uuid not null references public.purchase_order(id) on delete cascade,
  item_id uuid not null references public.item(id),
  qty numeric(14,3) not null check (qty > 0),
  rate numeric(14,2) not null check (rate >= 0),
  gst_rate numeric(5,2) not null default 0 check (gst_rate >= 0),
  received_qty numeric(14,3) not null default 0 check (received_qty >= 0)
);

-- ---------- Stores ----------
create table if not exists public.grn (
  id uuid primary key default gen_random_uuid(),
  grn_no text not null unique,
  po_id uuid references public.purchase_order(id),
  vendor_id uuid not null references public.vendor(id),
  unit text not null,
  received_on date not null default current_date,
  status text not null default 'Draft' check (status in ('Draft','Posted','Reversed')),
  created_by uuid not null default auth.uid(),
  created_at timestamptz not null default now()
);

create table if not exists public.grn_line (
  id uuid primary key default gen_random_uuid(),
  grn_id uuid not null references public.grn(id) on delete cascade,
  item_id uuid not null references public.item(id),
  qty numeric(14,3) not null check (qty > 0),
  rate numeric(14,2) not null default 0 check (rate >= 0),
  batch_no text
);

create table if not exists public.inspection_lot (
  id uuid primary key default gen_random_uuid(),
  grn_line_id uuid not null references public.grn_line(id),
  accepted_qty numeric(14,3) not null default 0 check (accepted_qty >= 0),
  rejected_qty numeric(14,3) not null default 0 check (rejected_qty >= 0),
  status text not null default 'Pending'
    check (status in ('Pending','Passed','Partially passed','Failed','Closed')),
  inspected_by uuid,
  inspected_at timestamptz,
  remarks text
);

-- ---------- Stock ----------
-- Stock is held per item x unit x bucket (PLAN.md 5.1-5.2).
create table if not exists public.stock_balance (
  item_id uuid not null references public.item(id),
  unit text not null,
  bucket text not null check (bucket in ('Unrestricted','QI','Blocked','Reserved','WIP','FG')),
  qty numeric(14,3) not null default 0 check (qty >= 0),
  primary key (item_id, unit, bucket)
);

-- Append-only ledger (PLAN.md 5.3). Rows are never updated or deleted.
create table if not exists public.stock_ledger (
  id bigint generated always as identity primary key,
  item_id uuid not null references public.item(id),
  unit text not null,
  bucket text not null check (bucket in ('Unrestricted','QI','Blocked','Reserved','WIP','FG')),
  movement_code text not null check (movement_code in ('OPN','GRN','QCP','QCF','PRT','TRF','ISS','RET','CON','FGR','DSP','ADJ+','ADJ-','REV')),
  qty numeric(14,3) not null check (qty <> 0),
  source_doc text,
  remarks text,
  posted_by uuid not null default auth.uid(),
  posted_at timestamptz not null default now()
);

create or replace function public.prevent_ledger_change()
returns trigger language plpgsql as $$
begin
  raise exception 'stock_ledger is append-only; post a REV movement instead';
end $$;

create trigger stock_ledger_no_update before update or delete on public.stock_ledger
  for each row execute function public.prevent_ledger_change();

-- The only way to change stock: writes the ledger row and the balance in one transaction,
-- and refuses any change that would take a bucket below zero.
create or replace function public.post_stock_movement(
  p_item_id uuid, p_unit text, p_bucket text, p_qty numeric,
  p_movement_code text, p_source_doc text default null, p_remarks text default null
) returns void
language plpgsql security definer set search_path = public
as $$
begin
  if p_qty = 0 then raise exception 'Quantity must not be zero'; end if;

  insert into public.stock_balance (item_id, unit, bucket, qty)
  values (p_item_id, p_unit, p_bucket, 0)
  on conflict (item_id, unit, bucket) do nothing;

  update public.stock_balance
     set qty = qty + p_qty
   where item_id = p_item_id and unit = p_unit and bucket = p_bucket;
  -- check constraint (qty >= 0) raises if the bucket would go negative

  insert into public.stock_ledger (item_id, unit, bucket, movement_code, qty, source_doc, remarks)
  values (p_item_id, p_unit, p_bucket, p_movement_code, p_qty, p_source_doc, p_remarks);
end $$;

revoke all on function public.post_stock_movement(uuid, text, text, numeric, text, text, text) from public;
grant execute on function public.post_stock_movement(uuid, text, text, numeric, text, text, text) to authenticated;

-- ---------- Row-level security ----------
-- First release: any signed-in user can use these modules. Finer role rules come with the
-- role model from the HRMS gates. The ledger and balances are read-only to clients;
-- they change only through post_stock_movement().
do $$
declare t text;
begin
  foreach t in array array['uom','item','bom_header','bom_line','vendor','purchase_order','po_line',
                           'grn','grn_line','inspection_lot']
  loop
    execute format('alter table public.%I enable row level security', t);
    execute format('create policy "signed_in_all" on public.%I for all to authenticated using (true) with check (true)', t);
  end loop;

  foreach t in array array['stock_balance','stock_ledger']
  loop
    execute format('alter table public.%I enable row level security', t);
    execute format('create policy "signed_in_read" on public.%I for select to authenticated using (true)', t);
  end loop;
end $$;
