-- Preserve custom EF templates across the imported 20260810120000 migration.
-- The helper and fence are intentionally replay-safe: a paused deployment may
-- rerun this prelude without replacing the original snapshot.

BEGIN;

CREATE TABLE IF NOT EXISTS public._btl_custom_2012_preservation (
  template_id UUID PRIMARY KEY,
  company_id UUID,
  team_id UUID,
  created_by UUID,
  original_lines JSONB NOT NULL,
  expected_imported_lines JSONB NOT NULL,
  original_other_fields JSONB NOT NULL,
  original_updated_at TIMESTAMPTZ NOT NULL,
  CHECK (company_id IS NOT NULL OR team_id IS NOT NULL)
);

ALTER TABLE public._btl_custom_2012_preservation ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public._btl_custom_2012_preservation FROM PUBLIC, anon, authenticated;

-- Application DML normally takes ROW EXCLUSIVE. Hold the conflicting table
-- lock until commit so no writer can land after capture but before the fence.
-- ACCESS SHARE remains compatible, so ordinary reads continue throughout.
LOCK TABLE public.booking_template_library IN SHARE ROW EXCLUSIVE MODE;

INSERT INTO public._btl_custom_2012_preservation (
  template_id,
  company_id,
  team_id,
  created_by,
  original_lines,
  expected_imported_lines,
  original_other_fields,
  original_updated_at
)
SELECT
  template.id,
  template.company_id,
  template.team_id,
  template.created_by,
  template.lines,
  (
    SELECT jsonb_agg(
      CASE
        WHEN line->>'account' = '2012'
          THEN jsonb_set(line, '{account}', '"2013"')
        ELSE line
      END
      ORDER BY ord
    )
    FROM jsonb_array_elements(template.lines) WITH ORDINALITY AS item(line, ord)
  ),
  to_jsonb(template) - ARRAY['lines', 'updated_at']::text[],
  template.updated_at
FROM public.booking_template_library template
WHERE template.is_system = false
  AND template.entity_type = 'enskild_firma'
  AND template.lines @> '[{"account": "2012"}]'
ON CONFLICT (template_id) DO NOTHING;

-- SECURITY INVOKER is deliberate. current_user and session_user must both be
-- trusted migration roles, so a caller cannot acquire the exception merely by
-- entering a definer-owned function. Application and authenticated writes fail
-- closed for the whole preservation window.
CREATE OR REPLACE FUNCTION public.fence_custom_2012_templates()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE
  snapshot public._btl_custom_2012_preservation%ROWTYPE;
  trusted_migration_role boolean :=
    current_user IN ('postgres', 'supabase_admin')
    AND session_user IN ('postgres', 'supabase_admin');
  old_is_custom_2012 boolean := false;
  new_is_custom_2012 boolean := false;
BEGIN
  IF TG_OP <> 'INSERT' THEN
    old_is_custom_2012 :=
      OLD.is_system = false
      AND OLD.entity_type = 'enskild_firma'
      AND OLD.lines @> '[{"account": "2012"}]';
  END IF;
  IF TG_OP <> 'DELETE' THEN
    new_is_custom_2012 :=
      NEW.is_system = false
      AND NEW.entity_type = 'enskild_firma'
      AND NEW.lines @> '[{"account": "2012"}]';
  END IF;

  IF TG_OP = 'INSERT' THEN
    IF new_is_custom_2012 THEN
      RAISE EXCEPTION 'Custom EF templates containing account 2012 are fenced during migration'
        USING ERRCODE = '55000';
    END IF;
    RETURN NEW;
  END IF;

  SELECT preservation.*
  INTO snapshot
  FROM public._btl_custom_2012_preservation preservation
  WHERE preservation.template_id = OLD.id;

  IF TG_OP = 'DELETE' THEN
    IF snapshot.template_id IS NOT NULL OR old_is_custom_2012 THEN
      RAISE EXCEPTION 'Custom EF template is fenced during migration'
        USING ERRCODE = '55000';
    END IF;
    RETURN OLD;
  END IF;

  IF snapshot.template_id IS NOT NULL THEN
    IF trusted_migration_role
       AND OLD.lines = snapshot.original_lines
       AND NEW.lines = snapshot.expected_imported_lines
       AND to_jsonb(NEW) - ARRAY['lines', 'updated_at']::text[] =
           to_jsonb(OLD) - ARRAY['lines', 'updated_at']::text[]
       AND NEW.updated_at IS NOT DISTINCT FROM OLD.updated_at THEN
      RETURN NEW;
    END IF;

    RAISE EXCEPTION 'Snapshotted custom EF template accepts only the imported 2012 to 2013 transformation'
      USING ERRCODE = '55000';
  END IF;

  IF old_is_custom_2012 OR new_is_custom_2012 THEN
    RAISE EXCEPTION 'Custom EF templates containing account 2012 are fenced during migration'
      USING ERRCODE = '55000';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS btl_custom_2012_write_fence
  ON public.booking_template_library;
CREATE TRIGGER btl_custom_2012_write_fence
  BEFORE INSERT OR UPDATE OR DELETE ON public.booking_template_library
  FOR EACH ROW
  EXECUTE FUNCTION public.fence_custom_2012_templates();

COMMIT;
