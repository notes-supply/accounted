-- Close the two state-integrity gaps found while reviewing mileage payroll
-- claims and WhatsApp phone-link replacement.

ALTER TABLE public.mileage_trips
  ADD COLUMN salary_line_item_id uuid
    REFERENCES public.salary_line_items(id) ON DELETE RESTRICT;

ALTER TABLE public.mileage_trips
  ADD CONSTRAINT mileage_trips_salary_line_requires_run
  CHECK (salary_line_item_id IS NULL OR salary_run_id IS NOT NULL);

CREATE INDEX idx_mileage_trips_salary_line_item
  ON public.mileage_trips (salary_line_item_id)
  WHERE salary_line_item_id IS NOT NULL;

-- New claims are protected by the salary_line_item_id RESTRICT foreign key.
-- Claims created before this migration have no exact line provenance, so a
-- direct cascade must fail closed instead of clearing salary_run_id and
-- recreating the booked-but-unlinked ambiguity this migration closes. The
-- atomic run-deletion command below releases all claims before deleting.
CREATE OR REPLACE FUNCTION public.block_salary_delete_with_mileage_claims()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_run_id uuid;
  v_has_claim boolean;
BEGIN
  IF TG_TABLE_NAME = 'salary_line_items' THEN
    SELECT salary_run_id INTO v_run_id
    FROM public.salary_run_employees
    WHERE id = OLD.salary_run_employee_id;

    SELECT EXISTS (
      SELECT 1 FROM public.mileage_trips
      WHERE salary_run_id = v_run_id
        AND salary_line_item_id IS NULL
    ) INTO v_has_claim;
  ELSIF TG_TABLE_NAME = 'salary_run_employees' THEN
    v_run_id := OLD.salary_run_id;
    SELECT EXISTS (
      SELECT 1 FROM public.mileage_trips
      WHERE salary_run_id = v_run_id
        AND salary_line_item_id IS NULL
    ) INTO v_has_claim;
  ELSE
    v_run_id := OLD.id;
    SELECT EXISTS (
      SELECT 1 FROM public.mileage_trips
      WHERE salary_run_id = v_run_id
    ) INTO v_has_claim;
  END IF;

  IF v_has_claim THEN
    RAISE EXCEPTION 'Cannot delete draft payroll content with linked mileage claims; use the atomic mileage-release command.'
      USING ERRCODE = '55000';
  END IF;
  RETURN OLD;
END;
$$;

CREATE TRIGGER salary_line_items_mileage_delete_guard
  BEFORE DELETE ON public.salary_line_items
  FOR EACH ROW EXECUTE FUNCTION public.block_salary_delete_with_mileage_claims();
CREATE TRIGGER salary_run_employees_mileage_delete_guard
  BEFORE DELETE ON public.salary_run_employees
  FOR EACH ROW EXECUTE FUNCTION public.block_salary_delete_with_mileage_claims();
CREATE TRIGGER salary_runs_mileage_delete_guard
  BEFORE DELETE ON public.salary_runs
  FOR EACH ROW EXECUTE FUNCTION public.block_salary_delete_with_mileage_claims();

-- Preserve the booked-row immutability contract while allowing an atomic
-- release command to clear both payroll pointers when returning a claim to
-- draft. Payroll pointers cannot be added, repointed, or cleared while a trip
-- remains booked.
CREATE OR REPLACE FUNCTION public.enforce_booked_mileage_trip_immutability()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  core_changed boolean;
BEGIN
  IF OLD.status <> 'booked' THEN
    RETURN NEW;
  END IF;

  core_changed :=
       NEW.trip_date            IS DISTINCT FROM OLD.trip_date
    OR NEW.vehicle_type         IS DISTINCT FROM OLD.vehicle_type
    OR NEW.vehicle_registration IS DISTINCT FROM OLD.vehicle_registration
    OR NEW.odometer_start       IS DISTINCT FROM OLD.odometer_start
    OR NEW.odometer_end         IS DISTINCT FROM OLD.odometer_end
    OR NEW.distance_km          IS DISTINCT FROM OLD.distance_km
    OR NEW.from_location        IS DISTINCT FROM OLD.from_location
    OR NEW.to_location          IS DISTINCT FROM OLD.to_location
    OR NEW.purpose              IS DISTINCT FROM OLD.purpose
    OR NEW.visited              IS DISTINCT FROM OLD.visited
    OR NEW.is_round_trip        IS DISTINCT FROM OLD.is_round_trip
    OR NEW.employee_id          IS DISTINCT FROM OLD.employee_id
    OR NEW.company_id           IS DISTINCT FROM OLD.company_id
    OR NEW.user_id              IS DISTINCT FROM OLD.user_id
    OR NEW.created_via          IS DISTINCT FROM OLD.created_via;

  IF core_changed THEN
    RAISE EXCEPTION 'Cannot modify a booked mileage trip: it is retained as underlag (BFL). Reverse the verifikat first.'
      USING ERRCODE = 'P0001';
  END IF;

  IF NEW.status = 'draft' THEN
    IF OLD.journal_entry_id IS NOT NULL THEN
      RAISE EXCEPTION 'Cannot unbook a mileage trip linked to a verifikat. Reverse the verifikat first.'
        USING ERRCODE = 'P0001';
    END IF;
    IF NEW.salary_run_id IS NOT NULL OR NEW.salary_line_item_id IS NOT NULL THEN
      RAISE EXCEPTION 'Reverting a mileage trip to draft must clear payroll links.'
        USING ERRCODE = 'P0001';
    END IF;
    RETURN NEW;
  END IF;

  IF OLD.journal_entry_id IS NOT NULL
     AND NEW.journal_entry_id IS DISTINCT FROM OLD.journal_entry_id THEN
    RAISE EXCEPTION 'Cannot repoint a booked mileage trip to another verifikat.'
      USING ERRCODE = 'P0001';
  END IF;
  IF OLD.salary_run_id IS NOT NULL
     AND NEW.salary_run_id IS DISTINCT FROM OLD.salary_run_id THEN
    RAISE EXCEPTION 'Cannot repoint a booked mileage trip to another salary run.'
      USING ERRCODE = 'P0001';
  END IF;
  IF NEW.salary_line_item_id IS DISTINCT FROM OLD.salary_line_item_id THEN
    RAISE EXCEPTION 'Cannot change a booked mileage trip salary-line link.'
      USING ERRCODE = 'P0001';
  END IF;

  RETURN NEW;
END;
$$;

-- Claim the exact draft trips and create their per-vehicle payroll lines in
-- one transaction. Each specification owns its exact trip IDs, so later
-- deletion can release only the claims represented by that line.
CREATE OR REPLACE FUNCTION public.claim_mileage_trips_for_salary_run(
  p_company_id uuid,
  p_salary_run_id uuid,
  p_employee_id uuid,
  p_trip_ids uuid[],
  p_line_specs jsonb
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_run_employee_id uuid;
  v_spec jsonb;
  v_line_id uuid;
  v_spec_trip_ids uuid[];
  v_claimed integer := 0;
  v_updated integer;
BEGIN
  IF auth.role() IS DISTINCT FROM 'service_role'
     AND NOT public.caller_can_write_company(p_company_id) THEN
    RAISE EXCEPTION 'salary run not found' USING ERRCODE = 'P0002';
  END IF;

  IF p_trip_ids IS NULL OR pg_catalog.cardinality(p_trip_ids) = 0
     OR pg_catalog.jsonb_typeof(p_line_specs) IS DISTINCT FROM 'array'
     OR pg_catalog.jsonb_array_length(p_line_specs) = 0 THEN
    RAISE EXCEPTION 'trip ids and line specifications are required'
      USING ERRCODE = '22023';
  END IF;

  SELECT sre.id INTO v_run_employee_id
  FROM public.salary_run_employees AS sre
  JOIN public.salary_runs AS sr ON sr.id = sre.salary_run_id
  WHERE sr.id = p_salary_run_id
    AND sr.company_id = p_company_id
    AND sr.status = 'draft'
    AND sre.company_id = p_company_id
    AND sre.employee_id = p_employee_id
  FOR UPDATE OF sr, sre;

  IF v_run_employee_id IS NULL THEN
    RAISE EXCEPTION 'salary run employee not found or run is not editable'
      USING ERRCODE = 'P0002';
  END IF;

  PERFORM 1
  FROM public.mileage_trips AS mt
  WHERE mt.id = ANY(p_trip_ids)
  ORDER BY mt.id
  FOR UPDATE;

  IF (SELECT pg_catalog.count(DISTINCT mt.id)
      FROM public.mileage_trips AS mt
      WHERE mt.id = ANY(p_trip_ids)
        AND mt.company_id = p_company_id
        AND mt.status = 'draft'
        AND mt.journal_entry_id IS NULL
        AND mt.salary_run_id IS NULL
        AND mt.salary_line_item_id IS NULL
        AND (mt.employee_id = p_employee_id OR mt.employee_id IS NULL))
     <> pg_catalog.cardinality(p_trip_ids)
     OR (SELECT pg_catalog.count(DISTINCT id) FROM pg_catalog.unnest(p_trip_ids) AS id)
        <> pg_catalog.cardinality(p_trip_ids) THEN
    RAISE EXCEPTION 'mileage trip claim lost' USING ERRCODE = '40001';
  END IF;

  FOR v_spec IN SELECT value FROM pg_catalog.jsonb_array_elements(p_line_specs)
  LOOP
    SELECT pg_catalog.array_agg(value::uuid)
      INTO v_spec_trip_ids
    FROM pg_catalog.jsonb_array_elements_text(v_spec->'trip_ids');

    IF v_spec_trip_ids IS NULL OR pg_catalog.cardinality(v_spec_trip_ids) = 0 THEN
      RAISE EXCEPTION 'each mileage line must own at least one trip'
        USING ERRCODE = '22023';
    END IF;

    INSERT INTO public.salary_line_items (
      salary_run_employee_id,
      company_id,
      item_type,
      description,
      quantity,
      unit_price,
      amount,
      is_taxable,
      is_avgift_basis,
      is_vacation_basis,
      is_gross_deduction,
      is_net_deduction,
      account_number,
      sort_order
    ) VALUES (
      v_run_employee_id,
      p_company_id,
      'mileage_taxfree',
      v_spec->>'description',
      (v_spec->>'quantity')::numeric,
      (v_spec->>'unit_price')::numeric,
      (v_spec->>'amount')::numeric,
      false,
      false,
      false,
      false,
      false,
      '7331',
      (v_spec->>'sort_order')::integer
    )
    RETURNING id INTO v_line_id;

    UPDATE public.mileage_trips
    SET status = 'booked',
        salary_run_id = p_salary_run_id,
        salary_line_item_id = v_line_id
    WHERE company_id = p_company_id
      AND status = 'draft'
      AND id = ANY(v_spec_trip_ids)
      AND id = ANY(p_trip_ids);
    GET DIAGNOSTICS v_updated = ROW_COUNT;

    IF v_updated <> pg_catalog.cardinality(v_spec_trip_ids) THEN
      RAISE EXCEPTION 'mileage line trip set is incomplete or duplicated'
        USING ERRCODE = '40001';
    END IF;
    v_claimed := v_claimed + v_updated;
  END LOOP;

  IF v_claimed <> pg_catalog.cardinality(p_trip_ids) THEN
    RAISE EXCEPTION 'mileage line specifications do not partition the trip set'
      USING ERRCODE = '22023';
  END IF;

  RETURN pg_catalog.jsonb_build_object('ok', true, 'trip_count', v_claimed);
END;
$$;

-- Delete one draft payroll object and release exactly the mileage claims it
-- owns in the same transaction. The salary-line foreign key blocks direct
-- cascades that bypass this command.
CREATE OR REPLACE FUNCTION public.delete_salary_draft_object_with_mileage_release(
  p_company_id uuid,
  p_salary_run_id uuid,
  p_kind text,
  p_target_id uuid
) RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_status text;
  v_deleted integer;
BEGIN
  IF auth.role() IS DISTINCT FROM 'service_role'
     AND NOT public.caller_can_write_company(p_company_id) THEN
    RETURN false;
  END IF;

  SELECT status INTO v_status
  FROM public.salary_runs
  WHERE id = p_salary_run_id AND company_id = p_company_id
  FOR UPDATE;

  IF v_status IS NULL OR v_status <> 'draft' THEN
    RETURN false;
  END IF;

  IF p_kind = 'line' THEN
    UPDATE public.mileage_trips AS mt
    SET status = 'draft', salary_run_id = NULL, salary_line_item_id = NULL
    WHERE mt.company_id = p_company_id
      AND mt.salary_run_id = p_salary_run_id
      AND mt.salary_line_item_id = p_target_id
      AND mt.journal_entry_id IS NULL;

    DELETE FROM public.salary_line_items AS sli
    USING public.salary_run_employees AS sre
    WHERE sli.id = p_target_id
      AND sli.company_id = p_company_id
      AND sre.id = sli.salary_run_employee_id
      AND sre.salary_run_id = p_salary_run_id;
  ELSIF p_kind = 'employee' THEN
    UPDATE public.mileage_trips AS mt
    SET status = 'draft', salary_run_id = NULL, salary_line_item_id = NULL
    WHERE mt.company_id = p_company_id
      AND mt.salary_run_id = p_salary_run_id
      AND mt.journal_entry_id IS NULL
      AND mt.salary_line_item_id IN (
        SELECT sli.id
        FROM public.salary_line_items AS sli
        WHERE sli.salary_run_employee_id = p_target_id
      );

    DELETE FROM public.salary_run_employees
    WHERE id = p_target_id
      AND company_id = p_company_id
      AND salary_run_id = p_salary_run_id;
  ELSIF p_kind = 'run' THEN
    IF p_target_id IS DISTINCT FROM p_salary_run_id THEN
      RETURN false;
    END IF;

    UPDATE public.mileage_trips
    SET status = 'draft', salary_run_id = NULL, salary_line_item_id = NULL
    WHERE company_id = p_company_id
      AND salary_run_id = p_salary_run_id
      AND journal_entry_id IS NULL;

    DELETE FROM public.salary_runs
    WHERE id = p_salary_run_id AND company_id = p_company_id;
  ELSE
    RAISE EXCEPTION 'unsupported salary draft object kind'
      USING ERRCODE = '22023';
  END IF;

  GET DIAGNOSTICS v_deleted = ROW_COUNT;
  RETURN v_deleted = 1;
END;
$$;

-- Consume a one-time code and replace conflicting phone links atomically. Any
-- insert or conversation failure rolls back the code claim and revocations.
CREATE OR REPLACE FUNCTION public.consume_whatsapp_code_and_create_link(
  p_code_hash text,
  p_phone_hash text,
  p_phone_enc text,
  p_phone_masked text,
  p_profile_name text,
  p_last_message_at timestamptz,
  p_service_window_expires_at timestamptz
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_code public.whatsapp_link_codes%ROWTYPE;
  v_link public.whatsapp_phone_links%ROWTYPE;
  v_conversation_id uuid;
BEGIN
  IF auth.role() IS DISTINCT FROM 'service_role' THEN
    RAISE EXCEPTION 'service role required' USING ERRCODE = '42501';
  END IF;

  SELECT * INTO v_code
  FROM public.whatsapp_link_codes
  WHERE code_hash = p_code_hash
    AND used_at IS NULL
    AND expires_at >= pg_catalog.clock_timestamp()
  FOR UPDATE;

  IF v_code.id IS NULL THEN
    RETURN pg_catalog.jsonb_build_object('ok', false);
  END IF;

  UPDATE public.whatsapp_link_codes
  SET used_at = pg_catalog.clock_timestamp()
  WHERE id = v_code.id;

  UPDATE public.whatsapp_phone_links
  SET revoked_at = pg_catalog.clock_timestamp()
  WHERE revoked_at IS NULL
    AND (phone_hash = p_phone_hash OR user_id = v_code.user_id);

  INSERT INTO public.whatsapp_phone_links (
    user_id,
    phone_hash,
    phone_enc,
    phone_masked,
    wa_profile_name,
    last_message_at
  ) VALUES (
    v_code.user_id,
    p_phone_hash,
    p_phone_enc,
    p_phone_masked,
    pg_catalog.left(p_profile_name, 200),
    p_last_message_at
  )
  RETURNING * INTO v_link;

  INSERT INTO public.whatsapp_conversations (
    phone_link_id,
    last_inbound_at,
    service_window_expires_at
  ) VALUES (
    v_link.id,
    p_last_message_at,
    p_service_window_expires_at
  )
  RETURNING id INTO v_conversation_id;

  RETURN pg_catalog.jsonb_build_object(
    'ok', true,
    'link', pg_catalog.to_jsonb(v_link),
    'conversation_id', v_conversation_id
  );
END;
$$;

REVOKE ALL ON FUNCTION public.claim_mileage_trips_for_salary_run(uuid, uuid, uuid, uuid[], jsonb)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.claim_mileage_trips_for_salary_run(uuid, uuid, uuid, uuid[], jsonb)
  TO authenticated, service_role;

REVOKE ALL ON FUNCTION public.delete_salary_draft_object_with_mileage_release(uuid, uuid, text, uuid)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.delete_salary_draft_object_with_mileage_release(uuid, uuid, text, uuid)
  TO authenticated, service_role;

REVOKE ALL ON FUNCTION public.consume_whatsapp_code_and_create_link(text, text, text, text, text, timestamptz, timestamptz)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.consume_whatsapp_code_and_create_link(text, text, text, text, text, timestamptz, timestamptz)
  TO service_role;

NOTIFY pgrst, 'reload schema';
