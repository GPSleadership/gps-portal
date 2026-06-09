-- Migration v46: pin search_path on the 4 flagged functions (F9)
-- Applied: 2026-06-09
-- Why: Supabase advisor WARN (function_search_path_mutable). A function without a fixed
--      search_path can, in narrow conditions, resolve objects from an attacker-influenced
--      schema. Pinning to (public, pg_temp) closes that. Handles overloads via identity args.

DO $$
DECLARE r record;
BEGIN
  FOR r IN
    SELECT 'ALTER FUNCTION public.'||p.proname||'('||pg_get_function_identity_arguments(p.oid)||') SET search_path = public, pg_temp' AS stmt
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public'
      AND p.proname IN ('update_updated_at','update_updated_at_column','get_survey_scoreboard','increment_ask_alex')
  LOOP
    EXECUTE r.stmt;
  END LOOP;
END $$;

-- ROLLBACK (rarely needed): re-create the functions without SET search_path, or
-- ALTER FUNCTION ... RESET search_path; — left out intentionally since pinning is strictly safer.
