-- Import from the Expert accounts backup (BKUPEXP.DAT = zip of FoxPro/dBase tables).
-- The browser reads the backup and sends rows here in batches. Everything is matched on the
-- Expert code, so importing the same or a newer backup again never creates duplicates.
--   * Masters every time: items (PRODUCT), suppliers (ACT, Sundry Creditors), customers (Sundry Debtors).
--   * Purchase history every time: purchase bill lines, for "Compare and choose".
--   * First import (baseline): opening stock = Expert closing quantity, and today's challans are marked seen.
--   * Later imports: every new store challan (PC) becomes a draft delivery (GRN) -> store check -> IQC.

alter table public.item add column if not exists expert_code text unique;
alter table public.item add column if not exists hsn_code text;
alter table public.vendor add column if not exists expert_code text unique;
alter table public.customer add column if not exists expert_code text unique;
alter table public.grn add column if not exists expert_link text unique;
alter table public.grn add column if not exists expert_doc_no text;

create table if not exists public.expert_import (
  id uuid primary key default gen_random_uuid(),
  backup_label text,
  backup_taken text,
  is_baseline boolean not null,
  counts jsonb,
  imported_by uuid not null default auth.uid(),
  started_at timestamptz not null default now(),
  finished_at timestamptz
);

create table if not exists public.expert_purchase_line (
  id bigint generated always as identity primary key,
  expert_link text not null,
  line_no int not null,
  kind text not null check (kind in ('PU', 'PR')),
  bill_no text,
  bill_date date,
  vendor_id uuid references public.vendor(id),
  item_id uuid references public.item(id),
  qty numeric(14,3),
  unit text,
  rate numeric(14,2),
  value numeric(14,2),
  unique (expert_link, line_no)
);

create table if not exists public.expert_seen_challan (
  link text primary key,
  doc_no text,
  challan_date date,
  grn_id uuid references public.grn(id) on delete set null,
  baseline boolean not null default false,
  import_id uuid references public.expert_import(id),
  seen_at timestamptz not null default now()
);

do $$
declare t text;
begin
  foreach t in array array['expert_import', 'expert_purchase_line', 'expert_seen_challan'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('create policy "signed_in_read" on public.%I for select to authenticated using (true)', t);
  end loop;
end $$;

-- Start an import. The first finished import is the baseline.
create or replace function public.expert_import_start(p_label text, p_taken text)
returns jsonb language plpgsql security definer set search_path = public
as $$
declare v_id uuid; v_base boolean;
begin
  v_base := not exists (select 1 from public.expert_import where is_baseline and finished_at is not null);
  insert into public.expert_import (backup_label, backup_taken, is_baseline) values (p_label, p_taken, v_base) returning id into v_id;
  return jsonb_build_object('import_id', v_id, 'baseline', v_base);
end $$;

create or replace function public.expert_import_finish(p_import_id uuid, p_counts jsonb)
returns void language plpgsql security definer set search_path = public
as $$
begin
  update public.expert_import set counts = p_counts, finished_at = now() where id = p_import_id;
end $$;

-- Items: insert new ones; for existing ones refresh name, description, HSN and active flag only
-- (stock unit, kind and code stay as they are once stock has moved).
create or replace function public.expert_upsert_items(p_rows jsonb)
returns jsonb language plpgsql security definer set search_path = public
as $$
declare r jsonb; ins int := 0; upd int := 0; was_new boolean;
begin
  for r in select * from jsonb_array_elements(p_rows) loop
    insert into public.uom (code, name) values (r->>'uom', r->>'uom') on conflict (code) do nothing;
    insert into public.item (expert_code, item_code, short_name, description, stock_uom, item_type, hsn_code, safety_stock, is_active)
    values (r->>'expert_code', r->>'item_code', left(r->>'short_name', 31), r->>'description', r->>'uom', r->>'item_type',
            nullif(r->>'hsn', ''), greatest(coalesce((r->>'safety')::numeric, 0), 0), coalesce((r->>'active')::boolean, true))
    on conflict (expert_code) do update
      set short_name = excluded.short_name, description = excluded.description,
          hsn_code = excluded.hsn_code, is_active = excluded.is_active
    returning (xmax = 0) into was_new;
    if was_new then ins := ins + 1; else upd := upd + 1; end if;
  end loop;
  return jsonb_build_object('new', ins, 'updated', upd);
end $$;

-- Suppliers ('vendor') or customers ('customer').
create or replace function public.expert_upsert_parties(p_kind text, p_rows jsonb)
returns jsonb language plpgsql security definer set search_path = public
as $$
declare r jsonb; ins int := 0; upd int := 0; was_new boolean;
begin
  if p_kind not in ('vendor', 'customer') then raise exception 'Unknown kind %', p_kind; end if;
  for r in select * from jsonb_array_elements(p_rows) loop
    if p_kind = 'vendor' then
      insert into public.vendor (expert_code, vendor_code, name, gstin, address, payment_terms)
      values (r->>'expert_code', r->>'code', r->>'name', nullif(r->>'gstin', ''), nullif(r->>'address', ''), nullif(r->>'payment_terms', ''))
      on conflict (expert_code) do update
        set name = excluded.name, gstin = excluded.gstin, address = excluded.address,
            payment_terms = coalesce(excluded.payment_terms, public.vendor.payment_terms)
      returning (xmax = 0) into was_new;
    else
      insert into public.customer (expert_code, customer_code, name, gstin, address)
      values (r->>'expert_code', r->>'code', r->>'name', nullif(r->>'gstin', ''), nullif(r->>'address', ''))
      on conflict (expert_code) do update
        set name = excluded.name, gstin = excluded.gstin, address = excluded.address
      returning (xmax = 0) into was_new;
    end if;
    if was_new then ins := ins + 1; else upd := upd + 1; end if;
  end loop;
  return jsonb_build_object('new', ins, 'updated', upd);
end $$;

-- Purchase bill lines (history for comparing supplier, price and terms).
create or replace function public.expert_add_purchase_lines(p_rows jsonb)
returns jsonb language plpgsql security definer set search_path = public
as $$
declare r jsonb; n int := 0; skipped int := 0; v uuid; it uuid;
begin
  for r in select * from jsonb_array_elements(p_rows) loop
    select id into v from public.vendor where expert_code = r->>'vendor_code';
    select id into it from public.item where expert_code = r->>'item_code';
    if v is null or it is null then skipped := skipped + 1; continue; end if;
    insert into public.expert_purchase_line (expert_link, line_no, kind, bill_no, bill_date, vendor_id, item_id, qty, unit, rate, value)
    values (r->>'link', (r->>'line_no')::int, r->>'kind', r->>'bill_no', (r->>'date')::date, v, it,
            (r->>'qty')::numeric, r->>'unit', (r->>'rate')::numeric, (r->>'value')::numeric)
    on conflict (expert_link, line_no) do nothing;
    if found then n := n + 1; end if;
  end loop;
  return jsonb_build_object('new', n, 'skipped', skipped);
end $$;

-- Baseline only: opening stock from Expert closing quantity, for items with no stock history yet.
create or replace function public.expert_opening_stock(p_import_id uuid, p_unit text, p_rows jsonb)
returns jsonb language plpgsql security definer set search_path = public
as $$
declare r jsonb; it uuid; q numeric; posted int := 0; neg int := 0; had int := 0; zero int := 0; imp record;
begin
  select * into imp from public.expert_import where id = p_import_id;
  if not found or not imp.is_baseline then raise exception 'Opening stock is only set on the first (baseline) import'; end if;
  for r in select * from jsonb_array_elements(p_rows) loop
    q := (r->>'qty')::numeric;
    if q is null or q = 0 then zero := zero + 1; continue; end if;
    if q < 0 then neg := neg + 1; continue; end if;
    select id into it from public.item where expert_code = r->>'expert_code';
    if it is null then continue; end if;
    if exists (select 1 from public.stock_ledger where item_id = it) then had := had + 1; continue; end if;
    perform public.post_stock_movement(it, p_unit, 'Unrestricted', q, 'OPN', 'EXPERT-OPENING',
      'Closing stock from Expert backup ' || coalesce(imp.backup_taken, ''));
    posted := posted + 1;
  end loop;
  return jsonb_build_object('posted', posted, 'negative_skipped', neg, 'already_had_stock', had, 'zero', zero);
end $$;

-- Store challans (PC). Baseline: mark as seen. Later: each new challan -> draft delivery (GRN).
create or replace function public.expert_challans(p_import_id uuid, p_unit text, p_rows jsonb)
returns jsonb language plpgsql security definer set search_path = public
as $$
declare r jsonb; l jsonb; imp record; v uuid; g uuid; it uuid; created int := 0; marked int := 0; already int := 0;
  skipped jsonb := '[]'::jsonb; missing text;
begin
  select * into imp from public.expert_import where id = p_import_id;
  if not found then raise exception 'Import not started'; end if;
  for r in select * from jsonb_array_elements(p_rows) loop
    if exists (select 1 from public.expert_seen_challan where link = r->>'link') then already := already + 1; continue; end if;
    if imp.is_baseline then
      insert into public.expert_seen_challan (link, doc_no, challan_date, baseline, import_id)
      values (r->>'link', r->>'doc_no', (r->>'date')::date, true, p_import_id);
      marked := marked + 1; continue;
    end if;
    select id into v from public.vendor where expert_code = r->>'vendor_code';
    missing := null;
    if v is null then missing := 'supplier ' || (r->>'vendor_code') || ' not found'; end if;
    for l in select * from jsonb_array_elements(r->'lines') loop
      if not exists (select 1 from public.item where expert_code = l->>'item_code') then
        missing := coalesce(missing || ', ', '') || 'item ' || (l->>'item_code') || ' not found';
      end if;
    end loop;
    if missing is not null then
      skipped := skipped || jsonb_build_object('doc_no', r->>'doc_no', 'reason', missing);
      continue;
    end if;
    insert into public.grn (grn_no, vendor_id, unit, received_on, status, expert_link, expert_doc_no, created_by)
    values (public.next_doc_no('GRN'), v, p_unit, (r->>'date')::date, 'Draft', r->>'link', r->>'doc_no', auth.uid())
    returning id into g;
    for l in select * from jsonb_array_elements(r->'lines') loop
      select id into it from public.item where expert_code = l->>'item_code';
      if (l->>'qty')::numeric > 0 then
        insert into public.grn_line (grn_id, item_id, qty, rate, batch_no)
        values (g, it, (l->>'qty')::numeric, coalesce((l->>'rate')::numeric, 0), nullif(l->>'batch', ''));
      end if;
    end loop;
    insert into public.expert_seen_challan (link, doc_no, challan_date, grn_id, baseline, import_id)
    values (r->>'link', r->>'doc_no', (r->>'date')::date, g, false, p_import_id);
    created := created + 1;
  end loop;
  return jsonb_build_object('deliveries_created', created, 'baseline_marked', marked, 'already_seen', already, 'skipped', skipped);
end $$;

do $$
declare f text;
begin
  foreach f in array array[
    'expert_import_start(text, text)', 'expert_import_finish(uuid, jsonb)', 'expert_upsert_items(jsonb)',
    'expert_upsert_parties(text, jsonb)', 'expert_add_purchase_lines(jsonb)',
    'expert_opening_stock(uuid, text, jsonb)', 'expert_challans(uuid, text, jsonb)'] loop
    execute format('revoke all on function public.%s from public, anon', f);
    execute format('grant execute on function public.%s to authenticated', f);
  end loop;
end $$;
