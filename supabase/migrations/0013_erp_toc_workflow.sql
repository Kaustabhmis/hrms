-- MAX ERP workflow (customer order -> ready for sale) with Theory of Constraints (Goldratt) support.
-- Adds: customers and customer orders (accept quantity), material buffer settings, purchase
-- requisitions, PO follow-up log, store quantity check before IQC, full-kit issue to production,
-- production records (WIP / FG) and dispatch. Every stock change still goes through
-- post_stock_movement(), one transaction per action, and stock can never go negative.

-- ---------- Customers and customer orders ----------
create table if not exists public.customer (
  id uuid primary key default gen_random_uuid(),
  customer_code text not null unique,
  name text not null,
  gstin text,
  address text,
  is_active boolean not null default true
);

create table if not exists public.customer_order (
  id uuid primary key default gen_random_uuid(),
  order_no text not null unique,
  customer_id uuid not null references public.customer(id),
  customer_po_no text,
  unit text not null,
  order_date date not null default current_date,
  due_date date not null,
  status text not null default 'Received'
    check (status in ('Received','Accepted','In production','Ready for sale','Closed','Cancelled')),
  created_by uuid not null default auth.uid(),
  created_at timestamptz not null default now(),
  constraint customer_order_due_after_order check (due_date >= order_date)
);

create table if not exists public.customer_order_line (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null references public.customer_order(id) on delete cascade,
  item_id uuid not null references public.item(id),
  ordered_qty numeric(14,3) not null check (ordered_qty > 0),
  accepted_qty numeric(14,3) check (accepted_qty >= 0),
  kitted_qty numeric(14,3) not null default 0 check (kitted_qty >= 0),
  produced_qty numeric(14,3) not null default 0 check (produced_qty >= 0),
  constraint col_accept_le_ordered check (accepted_qty is null or accepted_qty <= ordered_qty)
);

-- ---------- TOC stock buffer settings per item ----------
alter table public.item add column if not exists lead_time_days int not null default 7 check (lead_time_days > 0);
alter table public.item add column if not exists buffer_qty numeric(14,3) check (buffer_qty >= 0); -- null = worked out automatically

-- ---------- Purchase: requisitions, expected date, follow-up ----------
create table if not exists public.purchase_requisition (
  id uuid primary key default gen_random_uuid(),
  pr_no text not null unique,
  item_id uuid not null references public.item(id),
  unit text not null,
  qty numeric(14,3) not null check (qty > 0),
  needed_by date,
  reason text,
  status text not null default 'Open' check (status in ('Open','Ordered','Cancelled')),
  po_id uuid references public.purchase_order(id),
  created_by uuid not null default auth.uid(),
  created_at timestamptz not null default now()
);

alter table public.purchase_order add column if not exists expected_date date;

create table if not exists public.po_followup (
  id uuid primary key default gen_random_uuid(),
  po_id uuid not null references public.purchase_order(id) on delete cascade,
  followup_date date not null default current_date,
  promised_date date,
  remarks text not null,
  created_by uuid not null default auth.uid(),
  created_at timestamptz not null default now()
);

-- ---------- Store quantity check before IQC ----------
alter table public.grn_line add column if not exists store_check text not null default 'Pending'
  check (store_check in ('Pending','OK','Returned'));
alter table public.grn_line add column if not exists store_remarks text;

-- ---------- Production records ----------
create table if not exists public.production_record (
  id uuid primary key default gen_random_uuid(),
  order_line_id uuid references public.customer_order_line(id),
  item_id uuid not null references public.item(id),
  unit text not null,
  record_date date not null default current_date,
  fg_qty numeric(14,3) not null default 0 check (fg_qty >= 0),
  wip_qty numeric(14,3) not null default 0 check (wip_qty >= 0),
  remarks text,
  created_by uuid not null default auth.uid(),
  created_at timestamptz not null default now()
);

-- ---------- Row-level security for the new tables ----------
do $$
declare t text;
begin
  foreach t in array array['customer','customer_order','customer_order_line','purchase_requisition','po_followup','production_record']
  loop
    execute format('alter table public.%I enable row level security', t);
    execute format('create policy "signed_in_all" on public.%I for all to authenticated using (true) with check (true)', t);
  end loop;
end $$;

-- ---------- 2. Accept quantity ----------
create or replace function public.accept_order(p_order_id uuid, p_lines jsonb)
returns void language plpgsql security definer set search_path = public
as $$
declare o record; r jsonb;
begin
  select * into o from public.customer_order where id = p_order_id for update;
  if not found then raise exception 'Order not found'; end if;
  if o.status <> 'Received' then raise exception 'Order % is already %', o.order_no, o.status; end if;
  for r in select * from jsonb_array_elements(p_lines) loop
    update public.customer_order_line set accepted_qty = (r->>'qty')::numeric
     where id = (r->>'line_id')::uuid and order_id = p_order_id;
  end loop;
  if exists (select 1 from public.customer_order_line where order_id = p_order_id and accepted_qty is null) then
    raise exception 'Write the accepted quantity for every line';
  end if;
  update public.customer_order set status = 'Accepted' where id = p_order_id;
end $$;

-- ---------- 7. Make a PO from a requisition after comparing vendors ----------
create or replace function public.make_po_from_pr(p_pr_id uuid, p_vendor_id uuid, p_rate numeric)
returns uuid language plpgsql security definer set search_path = public
as $$
declare pr record; v_po uuid; v_no text;
begin
  select * into pr from public.purchase_requisition where id = p_pr_id for update;
  if not found then raise exception 'Requisition not found'; end if;
  if pr.status <> 'Open' then raise exception 'Requisition % is already %', pr.pr_no, pr.status; end if;
  if p_vendor_id is null then raise exception 'Choose a supplier'; end if;
  v_no := public.next_doc_no('PO');
  insert into public.purchase_order (po_no, vendor_id, unit, status, expected_date, created_by)
  values (v_no, p_vendor_id, pr.unit, 'Draft', pr.needed_by, auth.uid()) returning id into v_po;
  insert into public.po_line (po_id, item_id, qty, rate) values (v_po, pr.item_id, pr.qty, coalesce(p_rate, 0));
  update public.purchase_requisition set status = 'Ordered', po_id = v_po where id = p_pr_id;
  return v_po;
end $$;

-- ---------- 11. Store entry: verify quantity. Correct -> QI for IQC; not correct -> back to vendor ----------
create or replace function public.post_grn_checked(p_grn_id uuid, p_returned uuid[] default '{}', p_remarks text default null)
returns void language plpgsql security definer set search_path = public
as $$
declare g record; l record;
begin
  select * into g from public.grn where id = p_grn_id for update;
  if not found then raise exception 'Delivery not found'; end if;
  if g.status <> 'Draft' then raise exception 'Delivery % is already %', g.grn_no, g.status; end if;
  if not exists (select 1 from public.grn_line where grn_id = p_grn_id) then
    raise exception 'Delivery % has no lines', g.grn_no;
  end if;

  for l in select * from public.grn_line where grn_id = p_grn_id loop
    if l.id = any(coalesce(p_returned, '{}'::uuid[])) then
      update public.grn_line set store_check = 'Returned',
             store_remarks = coalesce(p_remarks, 'Quantity not correct, returned to vendor') where id = l.id;
    else
      update public.grn_line set store_check = 'OK' where id = l.id;
      insert into public.inspection_lot (grn_line_id, status) values (l.id, 'Pending');
      perform public.post_stock_movement(l.item_id, g.unit, 'QI', l.qty, 'GRN', g.grn_no, l.batch_no);
      if g.po_id is not null then
        update public.po_line set received_qty = received_qty + l.qty
         where id = (select id from public.po_line where po_id = g.po_id and item_id = l.item_id
                      order by (qty - received_qty) desc limit 1);
      end if;
    end if;
  end loop;

  update public.grn set status = 'Posted' where id = p_grn_id;
  if g.po_id is not null and not exists (select 1 from public.po_line where po_id = g.po_id and received_qty < qty) then
    update public.purchase_order set status = 'Closed' where id = g.po_id and status = 'Released';
  end if;
end $$;

-- ---------- 13. Send material for production: full kits only (TOC full-kit rule) ----------
create or replace function public.issue_kit(p_order_line_id uuid, p_unit text, p_qty numeric)
returns void language plpgsql security definer set search_path = public
as $$
declare ol record; o record; b record; l record; need numeric; have numeric; nm text;
begin
  select * into ol from public.customer_order_line where id = p_order_line_id for update;
  if not found then raise exception 'Order line not found'; end if;
  select * into o from public.customer_order where id = ol.order_id;
  if o.status not in ('Accepted', 'In production') then raise exception 'Order % must be accepted first', o.order_no; end if;
  if p_qty is null or p_qty <= 0 then raise exception 'How many must be more than 0'; end if;
  if ol.kitted_qty + p_qty > coalesce(ol.accepted_qty, 0) then
    raise exception 'That is more than the accepted quantity (% left to send)', coalesce(ol.accepted_qty, 0) - ol.kitted_qty;
  end if;

  select * into b from public.bom_header where fg_item_id = ol.item_id and is_active order by version desc limit 1;
  if not found then raise exception 'There is no recipe for this item yet'; end if;

  -- Check the whole kit first, so nothing moves unless every part is there.
  for l in select * from public.bom_line where bom_id = b.id loop
    need := p_qty * l.qty_per * (1 + l.scrap_pct / 100);
    select coalesce((select qty from public.stock_balance
                      where item_id = l.component_item_id and unit = p_unit and bucket = 'Unrestricted'), 0) into have;
    if have < need then
      select item_code || ' ' || short_name into nm from public.item where id = l.component_item_id;
      raise exception 'Not a full kit: % needs % but only % is ready to use', nm, round(need, 3)::float8, round(have, 3)::float8;
    end if;
  end loop;

  for l in select * from public.bom_line where bom_id = b.id loop
    need := p_qty * l.qty_per * (1 + l.scrap_pct / 100);
    perform public.post_stock_movement(l.component_item_id, p_unit, 'Unrestricted', -need, 'ISS', o.order_no, 'Full kit to production');
    perform public.post_stock_movement(l.component_item_id, p_unit, 'WIP', need, 'ISS', o.order_no, 'Full kit to production');
  end loop;

  update public.customer_order_line set kitted_qty = kitted_qty + p_qty where id = ol.id;
  update public.customer_order set status = 'In production' where id = o.id and status = 'Accepted';
end $$;

-- ---------- 14. Production record: WIP still in process, FG finished -> ready for sale ----------
create or replace function public.record_production(
  p_order_line_id uuid, p_unit text, p_fg_qty numeric, p_wip_qty numeric default 0, p_remarks text default null
) returns void language plpgsql security definer set search_path = public
as $$
declare ol record; o record; b record; l record; use_qty numeric;
begin
  select * into ol from public.customer_order_line where id = p_order_line_id for update;
  if not found then raise exception 'Order line not found'; end if;
  select * into o from public.customer_order where id = ol.order_id;
  p_fg_qty := coalesce(p_fg_qty, 0);
  p_wip_qty := coalesce(p_wip_qty, 0);
  if p_fg_qty < 0 or p_wip_qty < 0 then raise exception 'Numbers cannot be below 0'; end if;
  if p_fg_qty = 0 and p_wip_qty = 0 then raise exception 'Write how many are finished or still being made'; end if;
  if ol.produced_qty + p_fg_qty > ol.kitted_qty then
    raise exception 'Only % full kits were sent to production, so at most % more can be finished',
      ol.kitted_qty, ol.kitted_qty - ol.produced_qty;
  end if;

  if p_fg_qty > 0 then
    select * into b from public.bom_header where fg_item_id = ol.item_id and is_active order by version desc limit 1;
    if not found then raise exception 'There is no recipe for this item yet'; end if;
    for l in select * from public.bom_line where bom_id = b.id loop
      use_qty := p_fg_qty * l.qty_per * (1 + l.scrap_pct / 100);
      perform public.post_stock_movement(l.component_item_id, p_unit, 'WIP', -use_qty, 'CON', o.order_no, 'Used to make finished goods');
    end loop;
    perform public.post_stock_movement(ol.item_id, p_unit, 'FG', p_fg_qty, 'FGR', o.order_no, 'Finished, ready for sale');
    update public.customer_order_line set produced_qty = produced_qty + p_fg_qty where id = ol.id;
  end if;

  insert into public.production_record (order_line_id, item_id, unit, fg_qty, wip_qty, remarks)
  values (ol.id, ol.item_id, p_unit, p_fg_qty, p_wip_qty, p_remarks);

  if not exists (select 1 from public.customer_order_line where order_id = o.id and produced_qty < coalesce(accepted_qty, 0)) then
    update public.customer_order set status = 'Ready for sale' where id = o.id;
  end if;
end $$;

-- ---------- 15. Ready for sale -> sent to the customer ----------
create or replace function public.dispatch_order(p_order_id uuid)
returns void language plpgsql security definer set search_path = public
as $$
declare o record; ol record;
begin
  select * into o from public.customer_order where id = p_order_id for update;
  if not found then raise exception 'Order not found'; end if;
  if o.status <> 'Ready for sale' then raise exception 'Order % is %, not ready for sale', o.order_no, o.status; end if;
  for ol in select * from public.customer_order_line where order_id = p_order_id and accepted_qty > 0 loop
    perform public.post_stock_movement(ol.item_id, o.unit, 'FG', -ol.accepted_qty, 'DSP', o.order_no, 'Sent to customer');
  end loop;
  update public.customer_order set status = 'Closed' where id = p_order_id;
end $$;

-- ---------- Lock the new functions down: signed-in users only ----------
revoke all on function public.accept_order(uuid, jsonb) from public, anon;
revoke all on function public.make_po_from_pr(uuid, uuid, numeric) from public, anon;
revoke all on function public.post_grn_checked(uuid, uuid[], text) from public, anon;
revoke all on function public.issue_kit(uuid, text, numeric) from public, anon;
revoke all on function public.record_production(uuid, text, numeric, numeric, text) from public, anon;
revoke all on function public.dispatch_order(uuid) from public, anon;
grant execute on function public.accept_order(uuid, jsonb) to authenticated;
grant execute on function public.make_po_from_pr(uuid, uuid, numeric) to authenticated;
grant execute on function public.post_grn_checked(uuid, uuid[], text) to authenticated;
grant execute on function public.issue_kit(uuid, text, numeric) to authenticated;
grant execute on function public.record_production(uuid, text, numeric, numeric, text) to authenticated;
grant execute on function public.dispatch_order(uuid) to authenticated;
