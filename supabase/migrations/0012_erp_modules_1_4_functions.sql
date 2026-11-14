-- MAX ERP modules 1-4: units, document numbers, GRN posting, IQC, purchase returns, issues.
-- All stock changes go through post_stock_movement(); each business action runs in one transaction.

-- Standard units of measure.
insert into public.uom (code, name) values
  ('PCS','Pieces'), ('NOS','Numbers'), ('KG','Kilogram'), ('GM','Gram'),
  ('MTR','Metre'), ('ROLL','Roll'), ('SET','Set'), ('LTR','Litre')
on conflict (code) do nothing;

-- Purchase returns (PLAN 5.3 PRT). A return always goes back to the vendor on the original GRN.
create table if not exists public.purchase_return (
  id uuid primary key default gen_random_uuid(),
  inspection_lot_id uuid not null references public.inspection_lot(id),
  vendor_id uuid not null references public.vendor(id),
  qty numeric(14,3) not null check (qty > 0),
  remarks text,
  created_by uuid not null default auth.uid(),
  created_at timestamptz not null default now()
);
alter table public.purchase_return enable row level security;
create policy "signed_in_all" on public.purchase_return for all to authenticated using (true) with check (true);

-- Document numbers PREFIX/FY/NNNNN, Indian FY April-March (PLAN 8).
create table if not exists public.doc_sequence (
  prefix text not null,
  fy text not null,
  last_no int not null default 0,
  primary key (prefix, fy)
);
alter table public.doc_sequence enable row level security;

create or replace function public.next_doc_no(p_prefix text)
returns text language plpgsql security definer set search_path = public
as $$
declare
  y int := extract(year from current_date)::int;
  m int := extract(month from current_date)::int;
  start_y int := case when m >= 4 then y else y - 1 end;
  v_fy text := right(start_y::text, 2) || right((start_y + 1)::text, 2);
  n int;
begin
  insert into public.doc_sequence (prefix, fy, last_no) values (p_prefix, v_fy, 1)
  on conflict (prefix, fy) do update set last_no = public.doc_sequence.last_no + 1
  returning last_no into n;
  return p_prefix || '/' || v_fy || '/' || lpad(n::text, 5, '0');
end $$;
revoke all on function public.next_doc_no(text) from public, anon;
grant execute on function public.next_doc_no(text) to authenticated;

-- Post a GRN: stock into QI and one inspection lot per line. Posting is once only.
create or replace function public.post_grn(p_grn_id uuid)
returns void language plpgsql security definer set search_path = public
as $$
declare
  g record;
  l record;
begin
  select * into g from public.grn where id = p_grn_id for update;
  if not found then raise exception 'GRN not found'; end if;
  if g.status <> 'Draft' then raise exception 'GRN % is already %', g.grn_no, g.status; end if;
  if not exists (select 1 from public.grn_line where grn_id = p_grn_id) then
    raise exception 'GRN % has no lines', g.grn_no;
  end if;

  for l in select * from public.grn_line where grn_id = p_grn_id loop
    insert into public.inspection_lot (grn_line_id, status) values (l.id, 'Pending');
    perform public.post_stock_movement(l.item_id, g.unit, 'QI', l.qty, 'GRN', g.grn_no, l.batch_no);
  end loop;

  update public.grn set status = 'Posted' where id = p_grn_id;
end $$;

-- Record an inspection: accepted to Unrestricted (QCP), rejected to Blocked (QCF).
-- Accepted + rejected must equal the quantity received on the line.
create or replace function public.record_iqc(
  p_lot_id uuid, p_accepted numeric, p_rejected numeric, p_remarks text default null
) returns void language plpgsql security definer set search_path = public
as $$
declare
  lot record;
  ln record;
  g record;
  new_status text;
begin
  select * into lot from public.inspection_lot where id = p_lot_id for update;
  if not found then raise exception 'Inspection lot not found'; end if;
  if lot.status <> 'Pending' then raise exception 'Inspection lot is already %', lot.status; end if;

  select * into ln from public.grn_line where id = lot.grn_line_id;
  select * into g from public.grn where id = ln.grn_id;

  if p_accepted < 0 or p_rejected < 0 then raise exception 'Quantities cannot be negative'; end if;
  if p_accepted + p_rejected <> ln.qty then
    raise exception 'Accepted (%) + rejected (%) must equal the received quantity (%)', p_accepted, p_rejected, ln.qty;
  end if;

  if p_accepted > 0 then
    perform public.post_stock_movement(ln.item_id, g.unit, 'QI', -p_accepted, 'QCP', g.grn_no, p_remarks);
    perform public.post_stock_movement(ln.item_id, g.unit, 'Unrestricted', p_accepted, 'QCP', g.grn_no, p_remarks);
  end if;
  if p_rejected > 0 then
    perform public.post_stock_movement(ln.item_id, g.unit, 'QI', -p_rejected, 'QCF', g.grn_no, p_remarks);
    perform public.post_stock_movement(ln.item_id, g.unit, 'Blocked', p_rejected, 'QCF', g.grn_no, p_remarks);
  end if;

  new_status := case when p_rejected = 0 then 'Passed' when p_accepted = 0 then 'Failed' else 'Partially passed' end;
  update public.inspection_lot
     set accepted_qty = p_accepted, rejected_qty = p_rejected, status = new_status,
         inspected_by = auth.uid(), inspected_at = now(), remarks = p_remarks
   where id = p_lot_id;
end $$;

-- Purchase return from Blocked stock, always to the vendor on the original GRN.
create or replace function public.create_purchase_return(
  p_lot_id uuid, p_qty numeric, p_remarks text default null
) returns void language plpgsql security definer set search_path = public
as $$
declare
  lot record;
  ln record;
  g record;
  already numeric;
begin
  select * into lot from public.inspection_lot where id = p_lot_id for update;
  if not found then raise exception 'Inspection lot not found'; end if;
  if lot.rejected_qty <= 0 then raise exception 'Nothing was rejected on this lot'; end if;

  select coalesce(sum(qty), 0) into already from public.purchase_return where inspection_lot_id = p_lot_id;
  if p_qty <= 0 or p_qty > lot.rejected_qty - already then
    raise exception 'Return quantity must be between 0 and % (already returned: %)', lot.rejected_qty - already, already;
  end if;

  select * into ln from public.grn_line where id = lot.grn_line_id;
  select * into g from public.grn where id = ln.grn_id;

  perform public.post_stock_movement(ln.item_id, g.unit, 'Blocked', -p_qty, 'PRT', g.grn_no, p_remarks);
  insert into public.purchase_return (inspection_lot_id, vendor_id, qty, remarks)
  values (p_lot_id, g.vendor_id, p_qty, p_remarks);
end $$;

-- Material issue to production: Unrestricted to WIP (ISS).
create or replace function public.issue_material(
  p_item_id uuid, p_unit text, p_qty numeric, p_ref text default null
) returns void language plpgsql security definer set search_path = public
as $$
begin
  perform public.post_stock_movement(p_item_id, p_unit, 'Unrestricted', -p_qty, 'ISS', p_ref, 'Issue to production');
  perform public.post_stock_movement(p_item_id, p_unit, 'WIP', p_qty, 'ISS', p_ref, 'Issue to production');
end $$;

-- Lock the new functions down: signed-in users only.
revoke all on function public.post_grn(uuid) from public, anon;
revoke all on function public.record_iqc(uuid, numeric, numeric, text) from public, anon;
revoke all on function public.create_purchase_return(uuid, numeric, text) from public, anon;
revoke all on function public.issue_material(uuid, text, numeric, text) from public, anon;
revoke all on function public.post_stock_movement(uuid, text, text, numeric, text, text, text) from public, anon;
grant execute on function public.post_grn(uuid) to authenticated;
grant execute on function public.record_iqc(uuid, numeric, numeric, text) to authenticated;
grant execute on function public.create_purchase_return(uuid, numeric, text) to authenticated;
grant execute on function public.issue_material(uuid, text, numeric, text) to authenticated;
grant execute on function public.post_stock_movement(uuid, text, text, numeric, text, text, text) to authenticated;
