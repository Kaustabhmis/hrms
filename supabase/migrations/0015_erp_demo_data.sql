-- Sample data you can load and remove from the Home page.
-- Every sample record is marked so it can be found again:
--   items     : item_code starts with 99-9   (99-9xx codes are reserved for sample/test items)
--   customers : customer_code starts with DEMO-
--   suppliers : vendor_code starts with DEMO-
-- delete_demo_data() removes those records and everything linked to them (orders, POs,
-- deliveries, checks, stock and ledger rows). Nothing else is touched.

-- The ledger stays append-only, except that delete_demo_data() may remove sample items' rows.
create or replace function public.prevent_ledger_change()
returns trigger language plpgsql set search_path = public
as $$
begin
  if tg_op = 'DELETE' and current_setting('app.demo_cleanup', true) = 'on'
     and exists (select 1 from public.item where id = old.item_id and item_code like '99-9%') then
    return old;
  end if;
  raise exception 'stock_ledger is append-only; post a REV movement instead';
end $$;

create or replace function public.load_demo_data()
returns text language plpgsql security definer set search_path = public
as $$
declare
  me uuid := coalesce(auth.uid(), '00000000-0000-0000-0000-00000000d3e1');
  approver uuid := '00000000-0000-0000-0000-00000000d3e0';   -- a stand-in second person for past POs
  c1 uuid; c2 uuid; v1 uuid; v2 uuid; v3 uuid;
  pf uuid; wf uuid; bl uuid; mo uuid; gu uuid; st uuid; br uuid; ca uuid;
  b uuid; o uuid; ln uuid; po uuid;
begin
  if exists (select 1 from public.item where item_code = '99-901-01-01-01') then
    raise exception 'Sample data is already loaded. Remove it first.';
  end if;

  insert into public.customer (customer_code, name, address) values
    ('DEMO-C1', 'Demo Customer A', 'Sample address, Kolkata') returning id into c1;
  insert into public.customer (customer_code, name, address) values
    ('DEMO-C2', 'Demo Customer B', 'Sample address, Howrah') returning id into c2;
  insert into public.vendor (vendor_code, name, payment_terms) values ('DEMO-V1', 'Demo Blades Ltd', '30 days') returning id into v1;
  insert into public.vendor (vendor_code, name, payment_terms) values ('DEMO-V2', 'Demo Motors Co', '45 days') returning id into v2;
  insert into public.vendor (vendor_code, name, payment_terms) values ('DEMO-V3', 'Demo Packing Works', '15 days') returning id into v3;

  insert into public.item (item_code, short_name, stock_uom, item_type, lead_time_days) values ('99-901-01-01-01', 'Demo Pedestal Fan 400mm', 'PCS', 'FG', 5) returning id into pf;
  insert into public.item (item_code, short_name, stock_uom, item_type, lead_time_days) values ('99-902-01-01-01', 'Demo Wall Fan 400mm', 'PCS', 'FG', 5) returning id into wf;
  insert into public.item (item_code, short_name, stock_uom, item_type, lead_time_days, buffer_qty, moq) values ('99-911-01-01-01', 'Demo Blade 400mm', 'PCS', 'RM', 7, 150, 50) returning id into bl;
  insert into public.item (item_code, short_name, stock_uom, item_type, lead_time_days, buffer_qty, moq) values ('99-912-01-01-01', 'Demo Motor 400mm', 'PCS', 'BOP', 14, 80, 10) returning id into mo;
  insert into public.item (item_code, short_name, stock_uom, item_type, lead_time_days, buffer_qty, moq) values ('99-913-01-01-01', 'Demo Guard Set', 'SET', 'BOP', 10, 120, 20) returning id into gu;
  insert into public.item (item_code, short_name, stock_uom, item_type, lead_time_days, buffer_qty, moq) values ('99-914-01-01-01', 'Demo Pedestal Stand', 'PCS', 'BOP', 7, 40, 10) returning id into st;
  insert into public.item (item_code, short_name, stock_uom, item_type, lead_time_days, buffer_qty, moq) values ('99-915-01-01-01', 'Demo Wall Bracket', 'PCS', 'BOP', 7, 40, 10) returning id into br;
  insert into public.item (item_code, short_name, stock_uom, item_type, lead_time_days, buffer_qty, moq) values ('99-916-01-01-01', 'Demo Carton Box', 'PCS', 'Consumable', 5, 80, 25) returning id into ca;

  -- Recipes
  insert into public.bom_header (fg_item_id) values (pf) returning id into b;
  insert into public.bom_line (bom_id, component_item_id, qty_per, scrap_pct) values
    (b, bl, 3, 0), (b, mo, 1, 0), (b, gu, 1, 0), (b, st, 1, 0), (b, ca, 1, 0);
  insert into public.bom_header (fg_item_id) values (wf) returning id into b;
  insert into public.bom_line (bom_id, component_item_id, qty_per, scrap_pct) values
    (b, bl, 3, 2), (b, mo, 1, 0), (b, gu, 1, 0), (b, br, 1, 0), (b, ca, 1, 0);

  -- Opening stock (ready to use)
  perform public.post_stock_movement(bl, 'Unit 1', 'Unrestricted', 120, 'OPN', 'DEMO-OPENING', 'Sample opening stock');
  perform public.post_stock_movement(mo, 'Unit 1', 'Unrestricted', 25, 'OPN', 'DEMO-OPENING', 'Sample opening stock');
  perform public.post_stock_movement(gu, 'Unit 1', 'Unrestricted', 30, 'OPN', 'DEMO-OPENING', 'Sample opening stock');
  perform public.post_stock_movement(st, 'Unit 1', 'Unrestricted', 10, 'OPN', 'DEMO-OPENING', 'Sample opening stock');
  perform public.post_stock_movement(br, 'Unit 1', 'Unrestricted', 40, 'OPN', 'DEMO-OPENING', 'Sample opening stock');
  perform public.post_stock_movement(ca, 'Unit 1', 'Unrestricted', 60, 'OPN', 'DEMO-OPENING', 'Sample opening stock');
  perform public.post_stock_movement(bl, 'Unit 2', 'Unrestricted', 40, 'OPN', 'DEMO-OPENING', 'Sample opening stock');
  perform public.post_stock_movement(mo, 'Unit 2', 'Unrestricted', 15, 'OPN', 'DEMO-OPENING', 'Sample opening stock');
  perform public.post_stock_movement(gu, 'Unit 2', 'Unrestricted', 15, 'OPN', 'DEMO-OPENING', 'Sample opening stock');
  perform public.post_stock_movement(ca, 'Unit 2', 'Unrestricted', 20, 'OPN', 'DEMO-OPENING', 'Sample opening stock');

  -- Past purchases, so "Compare and choose" has history (finished POs)
  insert into public.purchase_order (po_no, vendor_id, unit, status, po_date, created_by, verified_by, released_by)
    values ('DEMO-PO-H1', v1, 'Unit 1', 'Closed', current_date - 40, me, approver, approver) returning id into po;
  insert into public.po_line (po_id, item_id, qty, rate, received_qty) values (po, bl, 200, 12.50, 200), (po, gu, 100, 38.00, 100);
  insert into public.purchase_order (po_no, vendor_id, unit, status, po_date, created_by, verified_by, released_by)
    values ('DEMO-PO-H2', v2, 'Unit 1', 'Closed', current_date - 25, me, approver, approver) returning id into po;
  insert into public.po_line (po_id, item_id, qty, rate, received_qty) values (po, mo, 50, 450.00, 50), (po, st, 40, 95.00, 40), (po, br, 40, 32.00, 40);
  insert into public.purchase_order (po_no, vendor_id, unit, status, po_date, created_by, verified_by, released_by)
    values ('DEMO-PO-H3', v1, 'Unit 1', 'Closed', current_date - 10, me, approver, approver) returning id into po;
  insert into public.po_line (po_id, item_id, qty, rate, received_qty) values (po, bl, 150, 12.00, 150), (po, st, 30, 99.00, 30);
  insert into public.purchase_order (po_no, vendor_id, unit, status, po_date, created_by, verified_by, released_by)
    values ('DEMO-PO-H4', v3, 'Unit 1', 'Closed', current_date - 15, me, approver, approver) returning id into po;
  insert into public.po_line (po_id, item_id, qty, rate, received_qty) values (po, ca, 200, 18.00, 200);

  -- Customer orders in different buffer colours
  insert into public.customer_order (order_no, customer_id, customer_po_no, unit, order_date, due_date, created_by)
    values (public.next_doc_no('SO'), c1, 'DEMO-CUST-PO-1', 'Unit 1', current_date - 10, current_date + 3, me) returning id into o;
  insert into public.customer_order_line (order_id, item_id, ordered_qty, accepted_qty) values (o, pf, 20, 20);
  update public.customer_order set status = 'Accepted' where id = o;

  insert into public.customer_order (order_no, customer_id, customer_po_no, unit, order_date, due_date, created_by)
    values (public.next_doc_no('SO'), c2, 'DEMO-CUST-PO-2', 'Unit 1', current_date, current_date + 20, me) returning id into o;
  insert into public.customer_order_line (order_id, item_id, ordered_qty, accepted_qty) values (o, wf, 30, 30);
  update public.customer_order set status = 'Accepted' where id = o;

  insert into public.customer_order (order_no, customer_id, customer_po_no, unit, order_date, due_date, created_by)
    values (public.next_doc_no('SO'), c1, 'DEMO-CUST-PO-3', 'Unit 1', current_date, current_date + 12, me) returning id into o;
  insert into public.customer_order_line (order_id, item_id, ordered_qty) values (o, pf, 15);

  return 'Sample data loaded';
end $$;

create or replace function public.delete_demo_data()
returns jsonb language plpgsql security definer set search_path = public
as $$
declare
  items uuid[]; custs uuid[]; vends uuid[];
  n_orders int; n_pos int; n_items int;
begin
  select coalesce(array_agg(id), '{}') into items from public.item where item_code like '99-9%';
  select coalesce(array_agg(id), '{}') into custs from public.customer where customer_code like 'DEMO-%';
  select coalesce(array_agg(id), '{}') into vends from public.vendor where vendor_code like 'DEMO-%';
  perform set_config('app.demo_cleanup', 'on', true);

  delete from public.production_record
   where item_id = any(items)
      or order_line_id in (select l.id from public.customer_order_line l join public.customer_order o on o.id = l.order_id where o.customer_id = any(custs));
  delete from public.customer_order
   where customer_id = any(custs) or id in (select order_id from public.customer_order_line where item_id = any(items));
  get diagnostics n_orders = row_count;

  delete from public.purchase_return
   where vendor_id = any(vends)
      or inspection_lot_id in (select il.id from public.inspection_lot il join public.grn_line gl on gl.id = il.grn_line_id where gl.item_id = any(items));
  delete from public.inspection_lot
   where grn_line_id in (select id from public.grn_line where item_id = any(items) or grn_id in (select id from public.grn where vendor_id = any(vends)));
  delete from public.grn
   where vendor_id = any(vends) or id in (select grn_id from public.grn_line where item_id = any(items));
  delete from public.purchase_requisition
   where item_id = any(items) or po_id in (select id from public.purchase_order where vendor_id = any(vends));
  delete from public.purchase_order
   where vendor_id = any(vends) or id in (select po_id from public.po_line where item_id = any(items));
  get diagnostics n_pos = row_count;

  delete from public.stock_ledger where item_id = any(items);
  delete from public.stock_balance where item_id = any(items);
  delete from public.bom_header
   where fg_item_id = any(items) or id in (select bom_id from public.bom_line where component_item_id = any(items));
  delete from public.item where id = any(items);
  get diagnostics n_items = row_count;
  delete from public.customer where id = any(custs);
  delete from public.vendor where id = any(vends);

  return jsonb_build_object('orders', n_orders, 'purchase_orders', n_pos, 'items', n_items,
                            'customers', coalesce(array_length(custs, 1), 0), 'suppliers', coalesce(array_length(vends, 1), 0));
end $$;

revoke all on function public.load_demo_data() from public, anon;
revoke all on function public.delete_demo_data() from public, anon;
grant execute on function public.load_demo_data() to authenticated;
grant execute on function public.delete_demo_data() to authenticated;
