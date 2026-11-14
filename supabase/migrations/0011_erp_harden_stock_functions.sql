-- Harden the stock functions added in 0010.
-- Signed-out (anon) users must not be able to post stock movements.
revoke all on function public.post_stock_movement(uuid, text, text, numeric, text, text, text) from anon;
-- Trigger function: fix its search path.
alter function public.prevent_ledger_change() set search_path = public;
