-- Migration v44: close the ghl_export_view leak (F1)
-- Applied: 2026-06-09 (applied directly to production via MCP; this file is the record)
-- Why: ghl_export_view was SECURITY DEFINER with SELECT granted to anon/authenticated,
--      so the publishable key could read every leader's name/email/role + TP3 scores,
--      bypassing the v26 RLS lockdown. No live consumer (verified: Make.com scenarios
--      pull FROM GoHighLevel, they do not read this view; any service-role reader is
--      unaffected because security_invoker still lets the service role bypass RLS).

ALTER VIEW public.ghl_export_view SET (security_invoker = true);
REVOKE SELECT ON public.ghl_export_view FROM anon, authenticated;

-- ROLLBACK:
-- ALTER VIEW public.ghl_export_view SET (security_invoker = false);
-- GRANT SELECT ON public.ghl_export_view TO anon, authenticated;
