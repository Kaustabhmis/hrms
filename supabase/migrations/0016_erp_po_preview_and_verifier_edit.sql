-- PO preview (who made it, who verified it, who sent it, and when) and verifier edits.
-- * The verifier can change supplier, expected date, payment terms, remarks and each line's
--   quantity, price and GST while the PO is waiting for verification (or still a draft).
-- * Every change is written to po_change_log: what changed, old value, new value, who, when.
-- * Once verified, the lines are locked (only the received quantity can still move).

alter table public.purchase_order add column if not exists payment_terms text;
alter table public.purchase_order add column if not exists remarks text;
alter table public.purchase_order add column if not exists verified_at timestamptz;
alter table public.purchase_order add column if not exists released_at timestamptz;

create table if not exists public.po_change_log (
  id uuid primary key default gen_random_uuid(),
  po_id uuid not null references public.purchase_order(id) on delete cascade,
  changed_by uuid not null default auth.uid(),
  changed_at timestamptz not null default now(),
  field text not null,
  old_value text,
  new_value text
);
alter table public.po_change_log enable row level security;
create policy "signed_in_read" on public.po_change_log for select to authenticated using (true);

-- Stamp who/when on each status step.
create or replace function public.po_stamp_status()
returns trigger language plpgsql set search_path = public
as $$
begin
  if new.status is distinct from old.status then
    if new.status = 'Verified' then
      new.verified_at := now();
      new.verified_by := coalesce(new.verified_by, auth.uid());
    elsif new.status = 'Released' then
      new.released_at := now();
      new.released_by := coalesce(new.released_by, auth.uid());
    end if;
  end if;
  return new;
end $$;
create trigger purchase_order_stamp_status before update on public.purchase_order
  for each row execute function public.po_stamp_status();

-- Lines can only change while the PO is a draft or waiting for verification.
create or replace function public.po_line_lock()
returns trigger language plpgsql set search_path = public
as $$
declare st text;
begin
  if current_setting('app.demo_cleanup', true) = 'on' then
    return coalesce(new, old);
  end if;
  select status into st from public.purchase_order where id = coalesce(new.po_id, old.po_id);
  if st is null or st in ('Draft', 'Pending verification') then
    return coalesce(new, old);
  end if;
  if tg_op = 'UPDATE' and new.item_id = old.item_id and new.qty = old.qty and new.rate = old.rate
     and new.gst_rate = old.gst_rate and new.po_id = old.po_id then
    return new;  -- receiving goods only moves received_qty
  end if;
  raise exception 'This PO is already %, so its lines cannot be changed', st;
end $$;
create trigger po_line_lock before insert or update or delete on public.po_line
  for each row execute function public.po_line_lock();

-- Verifier (or maker, while still a draft) edits the PO. Every change is logged.
create or replace function public.edit_po(
  p_po_id uuid, p_vendor_id uuid, p_expected_date date, p_payment_terms text, p_remarks text, p_lines jsonb
) returns int language plpgsql security definer set search_path = public
as $$
declare
  po record; ln record; r jsonb; n int := 0;
  v_old text; v_new text; nm text;
  q numeric; rt numeric; g numeric;
begin
  select * into po from public.purchase_order where id = p_po_id for update;
  if not found then raise exception 'PO not found'; end if;
  if po.status not in ('Draft', 'Pending verification') then
    raise exception 'PO % is already %, so it cannot be changed', po.po_no, po.status;
  end if;

  if p_vendor_id is not null and p_vendor_id is distinct from po.vendor_id then
    select name into v_old from public.vendor where id = po.vendor_id;
    select name into v_new from public.vendor where id = p_vendor_id;
    if v_new is null then raise exception 'Supplier not found'; end if;
    insert into public.po_change_log (po_id, field, old_value, new_value) values (p_po_id, 'Supplier', v_old, v_new);
    update public.purchase_order set vendor_id = p_vendor_id where id = p_po_id; n := n + 1;
  end if;
  if p_expected_date is distinct from po.expected_date then
    insert into public.po_change_log (po_id, field, old_value, new_value) values (p_po_id, 'Expected date', po.expected_date::text, p_expected_date::text);
    update public.purchase_order set expected_date = p_expected_date where id = p_po_id; n := n + 1;
  end if;
  if nullif(p_payment_terms, '') is distinct from po.payment_terms then
    insert into public.po_change_log (po_id, field, old_value, new_value) values (p_po_id, 'Payment terms', po.payment_terms, nullif(p_payment_terms, ''));
    update public.purchase_order set payment_terms = nullif(p_payment_terms, '') where id = p_po_id; n := n + 1;
  end if;
  if nullif(p_remarks, '') is distinct from po.remarks then
    insert into public.po_change_log (po_id, field, old_value, new_value) values (p_po_id, 'Remarks', po.remarks, nullif(p_remarks, ''));
    update public.purchase_order set remarks = nullif(p_remarks, '') where id = p_po_id; n := n + 1;
  end if;

  for r in select * from jsonb_array_elements(coalesce(p_lines, '[]'::jsonb)) loop
    select l.*, i.item_code || ' ' || i.short_name as item_name into ln
      from public.po_line l join public.item i on i.id = l.item_id
     where l.id = (r->>'line_id')::uuid and l.po_id = p_po_id;
    if not found then raise exception 'Line not found on this PO'; end if;
    q := coalesce((r->>'qty')::numeric, ln.qty);
    rt := coalesce((r->>'rate')::numeric, ln.rate);
    g := coalesce((r->>'gst_rate')::numeric, ln.gst_rate);
    if q <= 0 then raise exception 'Quantity for % must be more than 0', ln.item_name; end if;
    if rt < 0 or g < 0 then raise exception 'Price and GST for % cannot be below 0', ln.item_name; end if;
    if q <> ln.qty then
      insert into public.po_change_log (po_id, field, old_value, new_value) values (p_po_id, ln.item_name || ': quantity', ln.qty::float8::text, q::float8::text); n := n + 1;
    end if;
    if rt <> ln.rate then
      insert into public.po_change_log (po_id, field, old_value, new_value) values (p_po_id, ln.item_name || ': price', ln.rate::text, rt::text); n := n + 1;
    end if;
    if g <> ln.gst_rate then
      insert into public.po_change_log (po_id, field, old_value, new_value) values (p_po_id, ln.item_name || ': GST %', ln.gst_rate::float8::text, g::float8::text); n := n + 1;
    end if;
    update public.po_line set qty = q, rate = rt, gst_rate = g where id = ln.id;
  end loop;
  return n;
end $$;

-- Show people by email in the PO preview (internal staff only).
create or replace function public.user_emails(p_ids uuid[])
returns table (id uuid, email text) language sql security definer set search_path = public, auth
as $$ select u.id, u.email::text from auth.users u where u.id = any(p_ids) $$;

-- New POs take the supplier's payment terms.
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
  insert into public.purchase_order (po_no, vendor_id, unit, status, expected_date, payment_terms, created_by)
  values (v_no, p_vendor_id, pr.unit, 'Draft', pr.needed_by, (select payment_terms from public.vendor where id = p_vendor_id), auth.uid())
  returning id into v_po;
  insert into public.po_line (po_id, item_id, qty, rate) values (v_po, pr.item_id, pr.qty, coalesce(p_rate, 0));
  update public.purchase_requisition set status = 'Ordered', po_id = v_po where id = p_pr_id;
  return v_po;
end $$;

revoke all on function public.edit_po(uuid, uuid, date, text, text, jsonb) from public, anon;
revoke all on function public.user_emails(uuid[]) from public, anon;
grant execute on function public.edit_po(uuid, uuid, date, text, text, jsonb) to authenticated;
grant execute on function public.user_emails(uuid[]) to authenticated;

-- Existing POs: fill payment terms from the supplier.
update public.purchase_order po set payment_terms = v.payment_terms
  from public.vendor v where v.id = po.vendor_id and po.payment_terms is null;
