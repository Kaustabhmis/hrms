-- Supplier lead time (days from sending a PO to receiving the goods), set by the buyer.
-- The supplier comparison prefers the real average from our own POs and falls back to this.
alter table public.vendor add column if not exists lead_time_days int check (lead_time_days is null or lead_time_days >= 0);
