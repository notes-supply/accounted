-- Require the same writable company roles as the application before an
-- authenticated caller may invoke either accounting-mutating categorization
-- RPC. Service-role calls and trusted calls without JWT claims retain the
-- explicit bypass in each RPC body.

CREATE OR REPLACE FUNCTION public.caller_can_write_company(p_company_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $$
  SELECT COALESCE(
    p_company_id IS NOT NULL
    AND auth.uid() IS NOT NULL
    AND EXISTS (
      SELECT 1
        FROM public.company_members cm
       WHERE cm.user_id = auth.uid()
         AND cm.company_id = p_company_id
         AND cm.role IN ('owner', 'admin', 'member')
    ),
    false
  )
$$;

REVOKE ALL ON FUNCTION public.caller_can_write_company(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.caller_can_write_company(uuid)
  TO authenticated, service_role;

-- Recreate the exact installed definitions mechanically. This avoids copying
-- either accounting function body and is convergent when this migration is
-- reapplied to a disposable database during verification.
DO $$
DECLARE
  v_function regprocedure;
  v_definition text;
  v_rewritten_definition text;
  v_old_guard constant text :=
    'public.caller_is_company_member(p_company_id)';
  v_new_guard constant text :=
    'public.caller_can_write_company(p_company_id)';
BEGIN
  FOREACH v_function IN ARRAY ARRAY[
    'public.attach_transaction_categorization(uuid,uuid,uuid,uuid,text,boolean,text,uuid)'::regprocedure,
    'public.compensate_transaction_categorization(uuid,uuid,uuid)'::regprocedure
  ]
  LOOP
    SELECT pg_get_functiondef(v_function) INTO v_definition;

    IF position(v_new_guard IN v_definition) > 0 THEN
      CONTINUE;
    END IF;

    IF position(v_old_guard IN v_definition) = 0 THEN
      RAISE EXCEPTION
        'Expected categorization authorization guard is missing from %',
        v_function;
    END IF;

    v_rewritten_definition := replace(
      v_definition,
      v_old_guard,
      v_new_guard
    );
    EXECUTE v_rewritten_definition;
  END LOOP;
END;
$$;

NOTIFY pgrst, 'reload schema';
