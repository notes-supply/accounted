-- Restore custom EF templates after imported migration 20260810120000 and
-- remove the temporary fence atomically. Any unexpected intervening write is
-- a compare-and-swap failure, leaving the fence and snapshot in place.

DO $$
BEGIN
  IF to_regclass('public._btl_custom_2012_preservation') IS NULL THEN
    RAISE EXCEPTION 'Custom template preservation helper is missing';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM public._btl_custom_2012_preservation s
    LEFT JOIN public.booking_template_library b ON b.id = s.template_id
    WHERE b.id IS NULL
       OR b.is_system IS DISTINCT FROM false
       OR b.company_id IS DISTINCT FROM s.company_id
       OR b.team_id IS DISTINCT FROM s.team_id
       OR b.created_by IS DISTINCT FROM s.created_by
       OR b.lines IS DISTINCT FROM s.expected_imported_lines
       OR to_jsonb(b) - ARRAY['lines', 'updated_at']::text[]
          IS DISTINCT FROM s.original_other_fields
  ) THEN
    RAISE EXCEPTION 'Custom template drifted during preservation window';
  END IF;
END;
$$;

ALTER TABLE public.booking_template_library
  DISABLE TRIGGER btl_custom_2012_write_fence;
ALTER TABLE public.booking_template_library DISABLE TRIGGER btl_updated_at;

UPDATE public.booking_template_library b
SET lines = s.original_lines,
    updated_at = s.original_updated_at
FROM public._btl_custom_2012_preservation s
WHERE b.id = s.template_id
  AND b.is_system = false
  AND b.company_id IS NOT DISTINCT FROM s.company_id
  AND b.team_id IS NOT DISTINCT FROM s.team_id
  AND b.created_by IS NOT DISTINCT FROM s.created_by
  AND b.lines = s.expected_imported_lines;

ALTER TABLE public.booking_template_library ENABLE TRIGGER btl_updated_at;

DROP TRIGGER btl_custom_2012_write_fence
  ON public.booking_template_library;
DROP FUNCTION public.fence_custom_2012_templates();
DROP TABLE public._btl_custom_2012_preservation;
