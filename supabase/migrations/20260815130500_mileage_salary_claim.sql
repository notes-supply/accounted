-- WP5 M6 atomic mileage salary claims and exact draft release.
-- Symbolic draft: allocate a numeric migration version only at candidate freeze.
-- Depends on 20260815130100_journal_lineage_publication.sql.

ALTER TABLE public.mileage_trips
  ADD COLUMN salary_line_item_id uuid
  REFERENCES public.salary_line_items(id) ON DELETE RESTRICT;

CREATE INDEX idx_mileage_trips_salary_line_item
  ON public.mileage_trips (salary_line_item_id)
  WHERE salary_line_item_id IS NOT NULL;

COMMENT ON COLUMN public.mileage_trips.salary_line_item_id IS
  'Exact salary_line_items owner of a tax-free mileage claim. Immutable while booked.';

-- Replace the pre-M6 guard with complete provenance coherence. Salary claim
-- identifiers can be written and cleared only by the M6 RPC.
CREATE OR REPLACE FUNCTION public.enforce_booked_mileage_trip_immutability()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'pg_catalog', 'public'
AS $function$
DECLARE
  v_core_changed boolean;
  v_salary_claimed boolean;
  v_journal_booked boolean;
BEGIN
  v_salary_claimed :=
    NEW.status = 'booked'
    AND NEW.salary_run_id IS NOT NULL
    AND NEW.salary_line_item_id IS NOT NULL
    AND NEW.journal_entry_id IS NULL;
  v_journal_booked :=
    NEW.status = 'booked'
    AND NEW.journal_entry_id IS NOT NULL
    AND NEW.salary_run_id IS NULL
    AND NEW.salary_line_item_id IS NULL;

  IF (
    NEW.status = 'draft'
    AND (
      NEW.salary_run_id IS NOT NULL
      OR NEW.salary_line_item_id IS NOT NULL
      OR NEW.journal_entry_id IS NOT NULL
    )
  ) OR (
    NEW.status = 'booked'
    AND v_salary_claimed = v_journal_booked
  ) THEN
    RAISE EXCEPTION 'Mileage trip status and booking provenance are incoherent'
      USING ERRCODE = '23514';
  END IF;

  IF TG_OP = 'INSERT' THEN
    IF v_salary_claimed AND NOT accounting_private.has_accounting_command_capability(
      'mileage_salary_claim', NEW.company_id, NEW.id
    ) THEN
      RAISE EXCEPTION 'Salary mileage trips may be claimed only through claim_mileage_trips_for_salary'
        USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;

  IF OLD.status <> 'booked' THEN
    IF v_salary_claimed AND NOT accounting_private.has_accounting_command_capability(
      'mileage_salary_claim', NEW.company_id, NEW.id
    ) THEN
      RAISE EXCEPTION 'Salary mileage trips may be claimed only through claim_mileage_trips_for_salary'
        USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;

  v_core_changed :=
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

  IF v_core_changed THEN
    RAISE EXCEPTION 'Cannot modify a booked mileage trip retained as bookkeeping support'
      USING ERRCODE = '23514';
  END IF;

  IF NEW.status = 'draft' THEN
    IF OLD.journal_entry_id IS NOT NULL THEN
      RAISE EXCEPTION 'Cannot unbook a mileage trip linked to a posted journal entry'
        USING ERRCODE = '23514';
    END IF;
    IF NOT accounting_private.has_accounting_command_capability(
      'mileage_salary_release', OLD.company_id, OLD.id
    ) THEN
      RAISE EXCEPTION 'Salary mileage claims may be released only through the M6 deletion RPC'
        USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;

  IF OLD.journal_entry_id IS NOT NULL
     AND NEW.journal_entry_id IS DISTINCT FROM OLD.journal_entry_id THEN
    RAISE EXCEPTION 'Cannot repoint a booked mileage trip to another journal entry'
      USING ERRCODE = '23514';
  END IF;
  IF OLD.salary_run_id IS NOT NULL
     AND NEW.salary_run_id IS DISTINCT FROM OLD.salary_run_id THEN
    RAISE EXCEPTION 'Cannot repoint a booked mileage trip to another salary run'
      USING ERRCODE = '23514';
  END IF;
  IF OLD.salary_line_item_id IS NOT NULL
     AND NEW.salary_line_item_id IS DISTINCT FROM OLD.salary_line_item_id THEN
    RAISE EXCEPTION 'Cannot repoint a booked mileage trip to another salary line'
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END;
$function$;

REVOKE ALL ON FUNCTION public.enforce_booked_mileage_trip_immutability()
  FROM PUBLIC, anon, authenticated, service_role;

DROP TRIGGER IF EXISTS enforce_booked_mileage_trip_immutability
  ON public.mileage_trips;
CREATE TRIGGER enforce_booked_mileage_trip_immutability
  BEFORE INSERT OR UPDATE ON public.mileage_trips
  FOR EACH ROW EXECUTE FUNCTION public.enforce_booked_mileage_trip_immutability();

-- Salary object deletion is legal only after the same transaction has released
-- its exact mileage claims. The guard also runs for ON DELETE CASCADE children.
CREATE OR REPLACE FUNCTION public.guard_salary_mileage_claim_delete()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'pg_catalog', 'public'
AS $function$
DECLARE
  v_action text := CASE TG_TABLE_NAME
    WHEN 'salary_line_items' THEN 'salary_mileage_line_delete'
    WHEN 'salary_run_employees' THEN 'salary_mileage_employee_delete'
    ELSE 'salary_mileage_run_delete'
  END;
BEGIN
  IF NOT accounting_private.has_accounting_command_capability(
    v_action, OLD.company_id, OLD.id
  ) THEN
    RAISE EXCEPTION 'Salary objects with potential mileage claims may be deleted only through the M6 deletion RPC'
      USING ERRCODE = '23514';
  END IF;
  RETURN OLD;
END;
$function$;

CREATE TRIGGER guard_salary_line_mileage_claim_delete
  BEFORE DELETE ON public.salary_line_items
  FOR EACH ROW EXECUTE FUNCTION public.guard_salary_mileage_claim_delete();
CREATE TRIGGER guard_salary_run_employee_mileage_claim_delete
  BEFORE DELETE ON public.salary_run_employees
  FOR EACH ROW EXECUTE FUNCTION public.guard_salary_mileage_claim_delete();
CREATE TRIGGER guard_salary_run_mileage_claim_delete
  BEFORE DELETE ON public.salary_runs
  FOR EACH ROW EXECUTE FUNCTION public.guard_salary_mileage_claim_delete();

REVOKE ALL ON FUNCTION public.guard_salary_mileage_claim_delete()
  FROM PUBLIC, anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION public.claim_mileage_trips_for_salary(
  p_company_id uuid,
  p_salary_run_id uuid,
  p_salary_run_employee_id uuid,
  p_claims jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'pg_catalog', 'public'
AS $function$
DECLARE
  v_claims_count integer;
  v_trip_ids uuid[];
  v_trip_count integer;
  v_locked_trip_count integer;
  v_run_status text;
  v_run_year integer;
  v_config public.salary_payroll_config%ROWTYPE;
  v_employee_id uuid;
  v_claim record;
  v_line_item jsonb;
  v_claim_trip_ids uuid[];
  v_line_item_id uuid;
  v_updated_count integer;
  v_claimed_count integer := 0;
  v_created_count integer := 0;
  v_vehicle_type text;
  v_vehicle_type_count integer;
  v_seen_vehicle_types text[] := ARRAY[]::text[];
  v_expected_quantity numeric;
  v_expected_rate numeric;
  v_expected_amount numeric;
BEGIN
  IF p_company_id IS NULL OR p_salary_run_id IS NULL
     OR p_salary_run_employee_id IS NULL THEN
    RETURN jsonb_build_object('outcome', 'conflict');
  END IF;

  IF COALESCE(NULLIF(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role', '')
     = 'authenticated' THEN
    IF public.current_active_company_id() IS DISTINCT FROM p_company_id
       OR NOT public.current_user_can_write()
       OR NOT public.caller_is_company_member(p_company_id) THEN
      RAISE EXCEPTION 'Unauthorized mileage salary claim for company %', p_company_id
        USING ERRCODE = '42501';
    END IF;
  ELSIF COALESCE(NULLIF(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role', '')
        <> 'service_role' THEN
    RAISE EXCEPTION 'Mileage salary claim requires authenticated or service_role claims'
      USING ERRCODE = '42501';
  END IF;

  SELECT run.status, run.period_year
  INTO v_run_status, v_run_year
  FROM public.salary_runs run
  WHERE run.id = p_salary_run_id
    AND run.company_id = p_company_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('outcome', 'run_not_found');
  END IF;
  IF v_run_status <> 'draft' THEN
    RETURN jsonb_build_object('outcome', 'run_not_draft');
  END IF;

  SELECT run_employee.employee_id
  INTO v_employee_id
  FROM public.salary_run_employees run_employee
  WHERE run_employee.id = p_salary_run_employee_id
    AND run_employee.salary_run_id = p_salary_run_id
    AND run_employee.company_id = p_company_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('outcome', 'employee_not_in_run');
  END IF;

  IF jsonb_typeof(p_claims) IS DISTINCT FROM 'array'
     OR jsonb_array_length(p_claims) = 0 THEN
    RETURN jsonb_build_object('outcome', 'conflict');
  END IF;
  v_claims_count := jsonb_array_length(p_claims);

  BEGIN
    SELECT array_agg((trip.value #>> '{}')::uuid ORDER BY claim.ordinality, trip.ordinality)
    INTO v_trip_ids
    FROM jsonb_array_elements(p_claims) WITH ORDINALITY AS claim(value, ordinality)
    CROSS JOIN LATERAL jsonb_array_elements(claim.value -> 'trip_ids')
      WITH ORDINALITY AS trip(value, ordinality);
  EXCEPTION WHEN OTHERS THEN
    RETURN jsonb_build_object('outcome', 'conflict');
  END;

  v_trip_count := COALESCE(cardinality(v_trip_ids), 0);
  IF v_trip_count = 0
     OR v_trip_count <> (
       SELECT count(DISTINCT trip_id)
       FROM unnest(v_trip_ids) AS trip_id
     )
     OR EXISTS (
       SELECT 1
       FROM jsonb_array_elements(p_claims) AS claim(value)
       WHERE jsonb_typeof(claim.value) IS DISTINCT FROM 'object'
          OR NOT claim.value ?& ARRAY['trip_ids', 'line_item']
          OR (SELECT count(*) FROM jsonb_object_keys(claim.value) key) <> 2
          OR jsonb_typeof(claim.value -> 'trip_ids') IS DISTINCT FROM 'array'
          OR jsonb_array_length(claim.value -> 'trip_ids') = 0
          OR jsonb_typeof(claim.value -> 'line_item') IS DISTINCT FROM 'object'
          OR NOT (claim.value -> 'line_item') ?& ARRAY[
            'item_type', 'description', 'quantity', 'unit_price', 'amount',
            'is_taxable', 'is_avgift_basis', 'is_vacation_basis',
            'account_number', 'sort_order'
          ]
          OR (
            SELECT count(*)
            FROM jsonb_object_keys(claim.value -> 'line_item') key
          ) <> 10
     )
  THEN
    RETURN jsonb_build_object('outcome', 'conflict');
  END IF;

  -- Lock the complete de-duplicated trip set in stable UUID order before any
  -- semantic validation or salary-line insertion.
  PERFORM trip.id
  FROM public.mileage_trips trip
  WHERE trip.id = ANY(v_trip_ids)
  ORDER BY trip.id
  FOR UPDATE;
  GET DIAGNOSTICS v_locked_trip_count = ROW_COUNT;

  IF v_locked_trip_count IS DISTINCT FROM v_trip_count
     OR EXISTS (
       SELECT 1
       FROM public.mileage_trips trip
       WHERE trip.id = ANY(v_trip_ids)
         AND (
           trip.company_id IS DISTINCT FROM p_company_id
           OR (trip.employee_id IS NOT NULL AND trip.employee_id IS DISTINCT FROM v_employee_id)
           OR trip.status IS DISTINCT FROM 'draft'
           OR trip.salary_run_id IS NOT NULL
           OR trip.salary_line_item_id IS NOT NULL
           OR trip.journal_entry_id IS NOT NULL
         )
     ) THEN
    RETURN jsonb_build_object('outcome', 'conflict');
  END IF;

  SELECT config.*
  INTO v_config
  FROM public.salary_payroll_config config
  WHERE config.config_year = v_run_year
  FOR SHARE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('outcome', 'conflict');
  END IF;

  -- Validate one and only one claim partition per vehicle type. Every
  -- financial value is derived from the locked trips and locked annual config.
  BEGIN
    FOR v_claim IN
      SELECT claim.value, claim.ordinality
      FROM jsonb_array_elements(p_claims) WITH ORDINALITY AS claim(value, ordinality)
      ORDER BY claim.ordinality
    LOOP
      v_line_item := v_claim.value -> 'line_item';
      SELECT array_agg((trip.value #>> '{}')::uuid ORDER BY trip.ordinality)
      INTO v_claim_trip_ids
      FROM jsonb_array_elements(v_claim.value -> 'trip_ids')
        WITH ORDINALITY AS trip(value, ordinality);

      SELECT
        count(DISTINCT trip.vehicle_type)::integer,
        min(trip.vehicle_type),
        round((sum(round(trip.distance_km * 100) / 100) / 10) * 100) / 100
      INTO v_vehicle_type_count, v_vehicle_type, v_expected_quantity
      FROM public.mileage_trips trip
      WHERE trip.id = ANY(v_claim_trip_ids);

      v_expected_rate := CASE v_vehicle_type
        WHEN 'own_car' THEN v_config.milersattning_egen_bil
        WHEN 'company_car_fossil' THEN v_config.milersattning_formansbil_fossil
        WHEN 'company_car_electric' THEN v_config.milersattning_formansbil_el
        ELSE NULL
      END;
      v_expected_amount := round(
        v_expected_quantity * v_expected_rate * 100
      ) / 100;

      IF v_vehicle_type_count IS DISTINCT FROM 1
         OR v_vehicle_type = ANY(v_seen_vehicle_types)
         OR v_expected_rate IS NULL
         OR v_line_item ->> 'item_type' IS DISTINCT FROM 'mileage_taxfree'
         OR NULLIF(v_line_item ->> 'description', '') IS NULL
         OR jsonb_typeof(v_line_item -> 'quantity') IS DISTINCT FROM 'number'
         OR jsonb_typeof(v_line_item -> 'unit_price') IS DISTINCT FROM 'number'
         OR jsonb_typeof(v_line_item -> 'amount') IS DISTINCT FROM 'number'
         OR (v_line_item ->> 'quantity')::numeric IS DISTINCT FROM v_expected_quantity
         OR (v_line_item ->> 'unit_price')::numeric IS DISTINCT FROM v_expected_rate
         OR (v_line_item ->> 'amount')::numeric IS DISTINCT FROM v_expected_amount
         OR jsonb_typeof(v_line_item -> 'is_taxable') IS DISTINCT FROM 'boolean'
         OR jsonb_typeof(v_line_item -> 'is_avgift_basis') IS DISTINCT FROM 'boolean'
         OR jsonb_typeof(v_line_item -> 'is_vacation_basis') IS DISTINCT FROM 'boolean'
         OR (v_line_item ->> 'is_taxable')::boolean IS DISTINCT FROM false
         OR (v_line_item ->> 'is_avgift_basis')::boolean IS DISTINCT FROM false
         OR (v_line_item ->> 'is_vacation_basis')::boolean IS DISTINCT FROM false
         OR v_line_item ->> 'account_number' IS DISTINCT FROM '7331'
         OR jsonb_typeof(v_line_item -> 'sort_order') IS DISTINCT FROM 'number'
         OR (v_line_item ->> 'sort_order')::integer::numeric
            IS DISTINCT FROM (v_line_item ->> 'sort_order')::numeric THEN
        RETURN jsonb_build_object('outcome', 'conflict');
      END IF;

      v_seen_vehicle_types := array_append(v_seen_vehicle_types, v_vehicle_type);
    END LOOP;

    IF cardinality(v_seen_vehicle_types) IS DISTINCT FROM (
      SELECT count(DISTINCT trip.vehicle_type)::integer
      FROM public.mileage_trips trip
      WHERE trip.id = ANY(v_trip_ids)
    ) THEN
      RETURN jsonb_build_object('outcome', 'conflict');
    END IF;
  EXCEPTION WHEN OTHERS THEN
    RETURN jsonb_build_object('outcome', 'conflict');
  END;

  FOR v_claim IN
    SELECT claim.value, claim.ordinality
    FROM jsonb_array_elements(p_claims) WITH ORDINALITY AS claim(value, ordinality)
    ORDER BY claim.ordinality
  LOOP
    v_line_item := v_claim.value -> 'line_item';
    BEGIN
      SELECT array_agg((trip.value #>> '{}')::uuid ORDER BY trip.ordinality)
      INTO v_claim_trip_ids
      FROM jsonb_array_elements(v_claim.value -> 'trip_ids')
        WITH ORDINALITY AS trip(value, ordinality);
    EXCEPTION WHEN OTHERS THEN
      RAISE EXCEPTION 'Mileage claim trip IDs changed after validation'
        USING ERRCODE = '22023';
    END;


    INSERT INTO public.salary_line_items (
      salary_run_employee_id, company_id, item_type, description,
      quantity, unit_price, amount, is_taxable, is_avgift_basis,
      is_vacation_basis, is_gross_deduction, is_net_deduction,
      account_number, sort_order
    ) VALUES (
      p_salary_run_employee_id, p_company_id, 'mileage_taxfree',
      v_line_item ->> 'description',
      (v_line_item ->> 'quantity')::numeric,
      (v_line_item ->> 'unit_price')::numeric,
      round((v_line_item ->> 'amount')::numeric * 100) / 100,
      false, false, false, false, false, '7331',
      (v_line_item ->> 'sort_order')::integer
    ) RETURNING id INTO v_line_item_id;
    v_created_count := v_created_count + 1;

    PERFORM accounting_private.grant_accounting_command_capability(
      'mileage_salary_claim', p_company_id, trip_id
    )
    FROM unnest(v_claim_trip_ids) AS claimed(trip_id);

    UPDATE public.mileage_trips trip
    SET status = 'booked',
        salary_run_id = p_salary_run_id,
        salary_line_item_id = v_line_item_id
    WHERE trip.id = ANY(v_claim_trip_ids)
      AND trip.company_id = p_company_id
      AND (trip.employee_id = v_employee_id OR trip.employee_id IS NULL)
      AND trip.status = 'draft'
      AND trip.salary_run_id IS NULL
      AND trip.salary_line_item_id IS NULL
      AND trip.journal_entry_id IS NULL;
    GET DIAGNOSTICS v_updated_count = ROW_COUNT;
    IF v_updated_count IS DISTINCT FROM cardinality(v_claim_trip_ids) THEN
      RAISE EXCEPTION 'Mileage salary claim partition changed during mutation'
        USING ERRCODE = '40001';
    END IF;
    PERFORM accounting_private.revoke_accounting_command_capability(
      'mileage_salary_claim', p_company_id, trip_id
    )
    FROM unnest(v_claim_trip_ids) AS claimed(trip_id);
    v_claimed_count := v_claimed_count + v_updated_count;
  END LOOP;

  IF v_claimed_count IS DISTINCT FROM v_trip_count
     OR v_created_count IS DISTINCT FROM v_claims_count THEN
    RAISE EXCEPTION 'Mileage salary claim was incomplete'
      USING ERRCODE = '55000';
  END IF;

  RETURN jsonb_build_object(
    'outcome', 'claimed',
    'claimed_trip_count', v_claimed_count,
    'created_line_item_count', v_created_count
  );
END;
$function$;

REVOKE ALL ON FUNCTION public.claim_mileage_trips_for_salary(uuid, uuid, uuid, jsonb)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.claim_mileage_trips_for_salary(uuid, uuid, uuid, jsonb)
  TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.delete_draft_salary_object_with_mileage_release(
  p_company_id uuid,
  p_salary_run_id uuid,
  p_target_kind text,
  p_target_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'pg_catalog', 'public'
AS $function$
DECLARE
  v_run_status text;
  v_line_ids uuid[] := ARRAY[]::uuid[];
  v_run_employee_ids uuid[] := ARRAY[]::uuid[];
  v_trip_ids uuid[] := ARRAY[]::uuid[];
  v_expected_count integer := 0;
  v_released_count integer := 0;
  v_deleted_count integer := 0;
BEGIN
  IF p_company_id IS NULL OR p_salary_run_id IS NULL OR p_target_id IS NULL
     OR p_target_kind NOT IN ('line_item', 'run_employee', 'run') THEN
    RETURN jsonb_build_object(
      'outcome', 'conflict',
      'released_trip_count', 0,
      'expected_trip_count', 0
    );
  END IF;

  IF COALESCE(NULLIF(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role', '')
     = 'authenticated' THEN
    IF public.current_active_company_id() IS DISTINCT FROM p_company_id
       OR NOT public.current_user_can_write()
       OR NOT public.caller_is_company_member(p_company_id) THEN
      RAISE EXCEPTION 'Unauthorized salary mileage release for company %', p_company_id
        USING ERRCODE = '42501';
    END IF;
  ELSIF COALESCE(NULLIF(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role', '')
        <> 'service_role' THEN
    RAISE EXCEPTION 'Salary mileage release requires authenticated or service_role claims'
      USING ERRCODE = '42501';
  END IF;

  SELECT run.status
  INTO v_run_status
  FROM public.salary_runs run
  WHERE run.id = p_salary_run_id
    AND run.company_id = p_company_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object(
      'outcome', 'not_found',
      'released_trip_count', 0,
      'expected_trip_count', 0
    );
  END IF;
  IF v_run_status <> 'draft' THEN
    RETURN jsonb_build_object(
      'outcome', 'not_draft',
      'released_trip_count', 0,
      'expected_trip_count', 0,
      'current_status', v_run_status
    );
  END IF;

  IF p_target_kind = 'line_item' THEN
    SELECT ARRAY[line.id]::uuid[]
    INTO v_line_ids
    FROM public.salary_line_items line
    JOIN public.salary_run_employees run_employee
      ON run_employee.id = line.salary_run_employee_id
     AND run_employee.company_id = line.company_id
    WHERE line.id = p_target_id
      AND line.company_id = p_company_id
      AND run_employee.salary_run_id = p_salary_run_id
    FOR UPDATE OF line;
    IF NOT FOUND THEN
      RETURN jsonb_build_object(
        'outcome', 'not_found',
        'released_trip_count', 0,
        'expected_trip_count', 0
      );
    END IF;
  ELSIF p_target_kind = 'run_employee' THEN
    PERFORM run_employee.id
    FROM public.salary_run_employees run_employee
    WHERE run_employee.id = p_target_id
      AND run_employee.salary_run_id = p_salary_run_id
      AND run_employee.company_id = p_company_id
    FOR UPDATE;
    IF NOT FOUND THEN
      RETURN jsonb_build_object(
        'outcome', 'not_found',
        'released_trip_count', 0,
        'expected_trip_count', 0
      );
    END IF;
    v_run_employee_ids := ARRAY[p_target_id]::uuid[];

    SELECT COALESCE(array_agg(line.id ORDER BY line.id), ARRAY[]::uuid[])
    INTO v_line_ids
    FROM public.salary_line_items line
    WHERE line.salary_run_employee_id = p_target_id
      AND line.company_id = p_company_id;

    PERFORM line.id
    FROM public.salary_line_items line
    WHERE line.id = ANY(v_line_ids)
    ORDER BY line.id
    FOR UPDATE;
  ELSE
    IF p_target_id IS DISTINCT FROM p_salary_run_id THEN
      RETURN jsonb_build_object(
        'outcome', 'not_found',
        'released_trip_count', 0,
        'expected_trip_count', 0
      );
    END IF;

    SELECT COALESCE(
      array_agg(run_employee.id ORDER BY run_employee.id),
      ARRAY[]::uuid[]
    )
    INTO v_run_employee_ids
    FROM public.salary_run_employees run_employee
    WHERE run_employee.salary_run_id = p_salary_run_id
      AND run_employee.company_id = p_company_id;

    PERFORM run_employee.id
    FROM public.salary_run_employees run_employee
    WHERE run_employee.id = ANY(v_run_employee_ids)
    ORDER BY run_employee.id
    FOR UPDATE;

    SELECT COALESCE(array_agg(line.id ORDER BY line.id), ARRAY[]::uuid[])
    INTO v_line_ids
    FROM public.salary_line_items line
    JOIN public.salary_run_employees run_employee
      ON run_employee.id = line.salary_run_employee_id
     AND run_employee.company_id = line.company_id
    WHERE run_employee.salary_run_id = p_salary_run_id
      AND run_employee.company_id = p_company_id;

    PERFORM line.id
    FROM public.salary_line_items line
    WHERE line.id = ANY(v_line_ids)
    ORDER BY line.id
    FOR UPDATE;
  END IF;

  IF p_target_kind = 'run' THEN
    SELECT COALESCE(array_agg(trip.id ORDER BY trip.id), ARRAY[]::uuid[])
    INTO v_trip_ids
    FROM public.mileage_trips trip
    WHERE trip.company_id = p_company_id
      AND trip.salary_run_id = p_salary_run_id;
  ELSE
    SELECT COALESCE(array_agg(trip.id ORDER BY trip.id), ARRAY[]::uuid[])
    INTO v_trip_ids
    FROM public.mileage_trips trip
    WHERE trip.company_id = p_company_id
      AND trip.salary_run_id = p_salary_run_id
      AND trip.salary_line_item_id = ANY(v_line_ids);
  END IF;

  PERFORM trip.id
  FROM public.mileage_trips trip
  WHERE trip.id = ANY(v_trip_ids)
  ORDER BY trip.id
  FOR UPDATE;
  v_expected_count := cardinality(v_trip_ids);

  IF EXISTS (
    SELECT 1
    FROM public.mileage_trips trip
    WHERE trip.id = ANY(v_trip_ids)
      AND (
        trip.company_id IS DISTINCT FROM p_company_id
        OR trip.salary_run_id IS DISTINCT FROM p_salary_run_id
        OR trip.status IS DISTINCT FROM 'booked'
        OR trip.journal_entry_id IS NOT NULL
        OR (
          trip.salary_line_item_id IS NOT NULL
          AND trip.salary_line_item_id <> ALL(v_line_ids)
        )
        OR (
          p_target_kind <> 'run'
          AND trip.salary_line_item_id IS NULL
        )
      )
  ) THEN
    RETURN jsonb_build_object(
      'outcome', 'conflict',
      'released_trip_count', 0,
      'expected_trip_count', v_expected_count
    );
  END IF;

  BEGIN
    PERFORM accounting_private.grant_accounting_command_capability(
      'mileage_salary_release', p_company_id, trip_id
    )
    FROM unnest(v_trip_ids) AS released(trip_id);

    UPDATE public.mileage_trips trip
    SET status = 'draft',
        salary_run_id = NULL,
        salary_line_item_id = NULL
    WHERE trip.id = ANY(v_trip_ids)
      AND trip.company_id = p_company_id
      AND trip.status = 'booked'
      AND trip.journal_entry_id IS NULL
      AND trip.salary_run_id = p_salary_run_id;
    GET DIAGNOSTICS v_released_count = ROW_COUNT;

    IF v_released_count IS DISTINCT FROM v_expected_count THEN
      RAISE EXCEPTION USING ERRCODE = 'P0601';
    END IF;

    PERFORM accounting_private.revoke_accounting_command_capability(
      'mileage_salary_release', p_company_id, trip_id
    )
    FROM unnest(v_trip_ids) AS released(trip_id);

    PERFORM accounting_private.grant_accounting_command_capability(
      'salary_mileage_line_delete', p_company_id, line_id
    )
    FROM unnest(v_line_ids) AS deleted_lines(line_id);

    IF p_target_kind IN ('run_employee', 'run') THEN
      PERFORM accounting_private.grant_accounting_command_capability(
        'salary_mileage_employee_delete', p_company_id, run_employee_id
      )
      FROM unnest(v_run_employee_ids) AS deleted_employees(run_employee_id);
    END IF;

    IF p_target_kind = 'run' THEN
      PERFORM accounting_private.grant_accounting_command_capability(
        'salary_mileage_run_delete', p_company_id, p_salary_run_id
      );
    END IF;

    IF p_target_kind = 'line_item' THEN
      DELETE FROM public.salary_line_items line
      WHERE line.id = p_target_id
        AND line.company_id = p_company_id;
    ELSIF p_target_kind = 'run_employee' THEN
      DELETE FROM public.salary_run_employees run_employee
      WHERE run_employee.id = p_target_id
        AND run_employee.salary_run_id = p_salary_run_id
        AND run_employee.company_id = p_company_id;
    ELSE
      DELETE FROM public.salary_runs run
      WHERE run.id = p_salary_run_id
        AND run.company_id = p_company_id
        AND run.status = 'draft';
    END IF;
    GET DIAGNOSTICS v_deleted_count = ROW_COUNT;

    IF v_deleted_count IS DISTINCT FROM 1 THEN
      RAISE EXCEPTION USING ERRCODE = 'P0601';
    END IF;

    PERFORM accounting_private.revoke_accounting_command_capability(
      'salary_mileage_line_delete', p_company_id, line_id
    )
    FROM unnest(v_line_ids) AS deleted_lines(line_id);
    PERFORM accounting_private.revoke_accounting_command_capability(
      'salary_mileage_employee_delete', p_company_id, run_employee_id
    )
    FROM unnest(v_run_employee_ids) AS deleted_employees(run_employee_id);
    IF p_target_kind = 'run' THEN
      PERFORM accounting_private.revoke_accounting_command_capability(
        'salary_mileage_run_delete', p_company_id, p_salary_run_id
      );
    END IF;
  EXCEPTION WHEN SQLSTATE 'P0601' THEN
    RETURN jsonb_build_object(
      'outcome', 'release_incomplete',
      'released_trip_count', 0,
      'expected_trip_count', v_expected_count
    );
  END;

  RETURN jsonb_build_object(
    'outcome', 'deleted',
    'released_trip_count', v_released_count,
    'expected_trip_count', v_expected_count
  );
END;
$function$;

REVOKE ALL ON FUNCTION public.delete_draft_salary_object_with_mileage_release(
  uuid, uuid, text, uuid
) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.delete_draft_salary_object_with_mileage_release(
  uuid, uuid, text, uuid
) TO authenticated, service_role;

NOTIFY pgrst, 'reload schema';
