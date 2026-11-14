-- Make the workflow the only way to move stock. These functions are still used inside the
-- workflow functions (which run as the owner), but signed-in users can no longer call them directly:
--   post_stock_movement - raw stock posting (would skip every check)
--   post_grn            - posts a delivery without the store quantity check (use post_grn_checked)
--   issue_material      - issues single items without the full-kit rule (use issue_kit)
revoke execute on function public.post_stock_movement(uuid, text, text, numeric, text, text, text) from authenticated;
revoke execute on function public.post_grn(uuid) from authenticated;
revoke execute on function public.issue_material(uuid, text, numeric, text) from authenticated;
