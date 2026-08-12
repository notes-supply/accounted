-- Bind fixed-asset disposal to the asset version used by the planner.
--
-- Asset corrections remain available until disposal. The final commit compares
-- the planner's version token under the asset row lock, so a concurrent
-- correction cannot post a stale voucher and freeze a newer register value.

CREATE OR REPLACE FUNCTION public.commit_asset_disposal(
  p_company_id uuid,
  p_asset_id uuid,
  p_expected_asset_updated_at timestamptz,
  p_entry_id uuid,
  p_fiscal_period_id uuid,
  p_disposal_type text,
  p_disposed_at date,
  p_disposed_proceeds numeric,
  p_proceeds_vat numeric,
  p_vat_treatment text,
  p_current_depreciation numeric,
  p_jamkning_amount numeric,
  p_jamkning_direction text,
  p_jamkning_remaining_years integer,
  p_jamkning_total_years integer,
  p_jamkning_original_input_vat numeric,
  p_jamkning_original_deduction_percent numeric,
  p_jamkning_new_deduction_percent numeric,
  p_actor_type text DEFAULT NULL,
  p_actor_label text DEFAULT NULL
)
RETURNS TABLE(voucher_number integer)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  v_asset_user_id uuid;
  v_acquisition_cost numeric;
  v_asset_updated_at timestamptz;
  v_entry_user_id uuid;
  v_schedule_id uuid;
  v_schedule_entry_id uuid;
  v_period_start date;
  v_period_closed boolean;
  v_period_locked_at timestamptz;
  v_company_lock_date date;
  v_voucher_number integer;
  v_jwt_role text := coalesce(
    nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role',
    ''
  );
BEGIN
  -- NULL-safe membership guard (20260703180000): never the raw
  -- "NOT IN (SELECT user_company_ids())" form, which is NULL-unsafe.
  IF v_jwt_role IN ('anon', 'authenticated')
     AND (
       NOT public.caller_is_company_member(p_company_id)
       OR NOT public.current_user_can_write()
     ) THEN
    RAISE EXCEPTION 'unauthorized asset disposal for company %', p_company_id
      USING ERRCODE = '42501';
  END IF;

  -- Disposal metadata invariants. The values are derived server-side by the
  -- same planner that builds the draft entry, but the RPC is independently
  -- callable, so reject internally inconsistent register metadata here.
  IF coalesce(p_disposed_proceeds, 0) < 0 OR coalesce(p_proceeds_vat, 0) < 0 THEN
    RAISE EXCEPTION 'Disposal proceeds and VAT must be non-negative'
      USING ERRCODE = '23514';
  END IF;
  IF p_proceeds_vat > 0 AND p_vat_treatment IS NULL THEN
    RAISE EXCEPTION 'Disposal VAT requires a VAT treatment'
      USING ERRCODE = '23514';
  END IF;
  IF p_proceeds_vat > p_disposed_proceeds THEN
    RAISE EXCEPTION 'Disposal VAT cannot exceed gross proceeds'
      USING ERRCODE = '23514';
  END IF;
  IF p_disposal_type = 'scrap' AND coalesce(p_disposed_proceeds, 0) <> 0 THEN
    RAISE EXCEPTION 'Scrapping (utrangering) cannot carry proceeds'
      USING ERRCODE = '23514';
  END IF;

  SELECT a.user_id, a.acquisition_cost, a.updated_at
    INTO v_asset_user_id, v_acquisition_cost, v_asset_updated_at
    FROM public.assets a
   WHERE a.id = p_asset_id
     AND a.company_id = p_company_id
     AND a.disposed_at IS NULL
   FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Asset not found or already disposed: %', p_asset_id
      USING ERRCODE = 'P0002';
  END IF;

  IF p_expected_asset_updated_at IS NULL
     OR v_asset_updated_at IS DISTINCT FROM p_expected_asset_updated_at THEN
    RAISE EXCEPTION 'Asset changed after disposal planning: %', p_asset_id
      USING ERRCODE = '40001';
  END IF;

  SELECT fp.period_start, fp.is_closed, fp.locked_at
    INTO v_period_start, v_period_closed, v_period_locked_at
    FROM public.fiscal_periods fp
   WHERE fp.id = p_fiscal_period_id
     AND fp.company_id = p_company_id
     AND p_disposed_at BETWEEN fp.period_start AND fp.period_end;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Fiscal period does not contain disposal date'
      USING ERRCODE = '22007';
  END IF;

  IF v_period_closed OR v_period_locked_at IS NOT NULL THEN
    RAISE EXCEPTION 'Cannot dispose asset in a locked or closed fiscal period'
      USING ERRCODE = '23514';
  END IF;

  SELECT cs.bookkeeping_locked_through
    INTO v_company_lock_date
    FROM public.company_settings cs
   WHERE cs.company_id = p_company_id;

  IF v_company_lock_date IS NOT NULL AND p_disposed_at <= v_company_lock_date THEN
    RAISE EXCEPTION 'Bookkeeping is locked through %', v_company_lock_date
      USING ERRCODE = '23514';
  END IF;

  IF EXISTS (
    SELECT 1
      FROM public.depreciation_schedules ds
      JOIN public.fiscal_periods fp ON fp.id = ds.fiscal_period_id
     WHERE ds.company_id = p_company_id
       AND ds.asset_id = p_asset_id
       AND ds.journal_entry_id IS NOT NULL
       AND fp.period_start > v_period_start
  ) THEN
    RAISE EXCEPTION 'Later depreciation is already posted for asset %', p_asset_id
      USING ERRCODE = '23514';
  END IF;

  IF p_entry_id IS NOT NULL THEN
    SELECT je.user_id
      INTO v_entry_user_id
      FROM public.journal_entries je
     WHERE je.id = p_entry_id
       AND je.company_id = p_company_id
       AND je.fiscal_period_id = p_fiscal_period_id
       AND je.entry_date = p_disposed_at
       AND je.status = 'draft'
       AND je.source_type = 'system'
     FOR UPDATE;

    IF NOT FOUND THEN
      RAISE EXCEPTION 'Valid disposal draft not found: %', p_entry_id
        USING ERRCODE = 'P0002';
    END IF;
  ELSIF abs(coalesce(v_acquisition_cost, 0)) > 0.005
     OR abs(coalesce(p_disposed_proceeds, 0)) > 0.005
     OR abs(coalesce(p_current_depreciation, 0)) > 0.005 THEN
    RAISE EXCEPTION 'A financially material asset disposal requires a disposal voucher'
      USING ERRCODE = '23514';
  END IF;

  IF coalesce(p_current_depreciation, 0) > 0.005 THEN
    SELECT ds.id, ds.journal_entry_id
      INTO v_schedule_id, v_schedule_entry_id
      FROM public.depreciation_schedules ds
     WHERE ds.asset_id = p_asset_id
       AND ds.fiscal_period_id = p_fiscal_period_id
     FOR UPDATE;

    IF FOUND AND v_schedule_entry_id IS NOT NULL THEN
      RAISE EXCEPTION 'Depreciation was posted concurrently for asset %', p_asset_id
        USING ERRCODE = '23514';
    ELSIF FOUND THEN
      UPDATE public.depreciation_schedules
         SET planned_depreciation = p_current_depreciation,
             journal_entry_id = p_entry_id,
             posted_at = now()
       WHERE id = v_schedule_id;
    ELSE
      INSERT INTO public.depreciation_schedules (
        user_id,
        company_id,
        asset_id,
        fiscal_period_id,
        planned_depreciation,
        journal_entry_id,
        posted_at
      ) VALUES (
        coalesce(v_entry_user_id, v_asset_user_id),
        p_company_id,
        p_asset_id,
        p_fiscal_period_id,
        p_current_depreciation,
        p_entry_id,
        now()
      );
    END IF;
  END IF;

  IF p_entry_id IS NOT NULL THEN
    SELECT committed.voucher_number
      INTO v_voucher_number
      -- commit_method must be one of journal_entries_commit_method_check's
      -- allowed values; the disposal dialog is a user-accepted commit.
      FROM public.commit_journal_entry(
        p_company_id,
        p_entry_id,
        'user_accept',
        NULL,
        p_actor_type,
        p_actor_label
      ) AS committed;
  END IF;

  UPDATE public.assets
     SET disposed_at = p_disposed_at,
         disposed_proceeds = p_disposed_proceeds,
         disposed_proceeds_vat = p_proceeds_vat,
         disposed_vat_treatment = p_vat_treatment,
         disposal_type = p_disposal_type,
         disposal_journal_entry_id = p_entry_id,
         jamkning_amount = p_jamkning_amount,
         jamkning_direction = p_jamkning_direction,
         jamkning_remaining_years = p_jamkning_remaining_years,
         jamkning_total_years = p_jamkning_total_years,
         jamkning_original_input_vat = p_jamkning_original_input_vat,
         jamkning_original_deduction_percent = p_jamkning_original_deduction_percent,
         jamkning_new_deduction_percent = p_jamkning_new_deduction_percent,
         jamkning_remaining_months = NULL,
         jamkning_total_months = NULL
   WHERE id = p_asset_id
     AND company_id = p_company_id
     AND disposed_at IS NULL;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Asset disposal lost concurrent update: %', p_asset_id
      USING ERRCODE = '40001';
  END IF;

  RETURN QUERY SELECT v_voucher_number;
END;
$function$;

REVOKE ALL ON FUNCTION public.commit_asset_disposal(
  uuid, uuid, uuid, uuid, text, date, numeric, numeric, text, numeric,
  numeric, text, integer, integer, numeric, numeric, numeric, text, text
) FROM PUBLIC, anon, authenticated, service_role;
DROP FUNCTION public.commit_asset_disposal(
  uuid, uuid, uuid, uuid, text, date, numeric, numeric, text, numeric,
  numeric, text, integer, integer, numeric, numeric, numeric, text, text
);

REVOKE ALL ON FUNCTION public.commit_asset_disposal(
  uuid, uuid, timestamptz, uuid, uuid, text, date, numeric, numeric, text, numeric,
  numeric, text, integer, integer, numeric, numeric, numeric, text, text
) FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.commit_asset_disposal(
  uuid, uuid, timestamptz, uuid, uuid, text, date, numeric, numeric, text, numeric,
  numeric, text, integer, integer, numeric, numeric, numeric, text, text
) TO service_role;

COMMENT ON FUNCTION public.commit_asset_disposal(
  uuid, uuid, timestamptz, uuid, uuid, text, date, numeric, numeric, text, numeric,
  numeric, text, integer, integer, numeric, numeric, numeric, text, text
) IS 'Atomically posts a fixed-asset disposal voucher, disposal-date depreciation schedule, and immutable asset-register state.';

NOTIFY pgrst, 'reload schema';
