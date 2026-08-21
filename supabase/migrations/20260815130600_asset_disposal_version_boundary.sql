-- WP5 M7 version-bound, service-only fixed-asset disposal.
-- Symbolic draft: allocate a numeric migration version only at candidate freeze.
-- Depends on 20260815130100_journal_lineage_publication.sql.

-- Remove the old callable contract. No compatibility overload remains.
REVOKE ALL ON FUNCTION public.commit_asset_disposal(
  uuid, uuid, uuid, uuid, text, date, numeric, numeric, text, numeric,
  numeric, text, integer, integer, numeric, numeric, numeric, text, text
) FROM PUBLIC, anon, authenticated, service_role;
DROP FUNCTION public.commit_asset_disposal(
  uuid, uuid, uuid, uuid, text, date, numeric, numeric, text, numeric,
  numeric, text, integer, integer, numeric, numeric, numeric, text, text
);

-- A first disposal transition is owned by the version-bound RPC. Existing
-- post-disposal immutability continues to protect every later update.
CREATE OR REPLACE FUNCTION public.guard_asset_disposal_boundary()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'pg_catalog', 'public'
AS $function$
BEGIN
  IF OLD.disposed_at IS NULL AND (
       NEW.disposed_at IS DISTINCT FROM OLD.disposed_at
    OR NEW.disposed_proceeds IS DISTINCT FROM OLD.disposed_proceeds
    OR NEW.disposed_proceeds_vat IS DISTINCT FROM OLD.disposed_proceeds_vat
    OR NEW.disposed_vat_treatment IS DISTINCT FROM OLD.disposed_vat_treatment
    OR NEW.disposal_type IS DISTINCT FROM OLD.disposal_type
    OR NEW.disposal_journal_entry_id IS DISTINCT FROM OLD.disposal_journal_entry_id
    OR NEW.jamkning_amount IS DISTINCT FROM OLD.jamkning_amount
    OR NEW.jamkning_remaining_months IS DISTINCT FROM OLD.jamkning_remaining_months
    OR NEW.jamkning_total_months IS DISTINCT FROM OLD.jamkning_total_months
    OR NEW.jamkning_original_input_vat IS DISTINCT FROM OLD.jamkning_original_input_vat
    OR NEW.jamkning_direction IS DISTINCT FROM OLD.jamkning_direction
    OR NEW.jamkning_remaining_years IS DISTINCT FROM OLD.jamkning_remaining_years
    OR NEW.jamkning_total_years IS DISTINCT FROM OLD.jamkning_total_years
    OR NEW.jamkning_original_deduction_percent IS DISTINCT FROM OLD.jamkning_original_deduction_percent
    OR NEW.jamkning_new_deduction_percent IS DISTINCT FROM OLD.jamkning_new_deduction_percent
  ) AND NOT accounting_private.has_accounting_command_capability(
    'asset_disposal_transition', OLD.company_id, OLD.id
  ) THEN
    RAISE EXCEPTION 'Asset disposal state may be set only through commit_asset_disposal'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$function$;

CREATE TRIGGER guard_asset_disposal_boundary
  BEFORE UPDATE ON public.assets
  FOR EACH ROW EXECUTE FUNCTION public.guard_asset_disposal_boundary();

REVOKE ALL ON FUNCTION public.guard_asset_disposal_boundary()
  FROM PUBLIC, anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION public.guard_asset_retained_delete()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'pg_catalog', 'public'
AS $function$
BEGIN
  IF OLD.disposed_at IS NOT NULL OR EXISTS (
    SELECT 1
    FROM public.depreciation_schedules schedule
    WHERE schedule.asset_id = OLD.id
      AND schedule.company_id = OLD.company_id
      AND schedule.journal_entry_id IS NOT NULL
  ) THEN
    RAISE EXCEPTION 'Cannot delete a disposed asset or an asset with posted depreciation history'
      USING ERRCODE = '23514';
  END IF;
  RETURN OLD;
END;
$function$;

CREATE TRIGGER guard_asset_retained_delete
  BEFORE DELETE ON public.assets
  FOR EACH ROW EXECUTE FUNCTION public.guard_asset_retained_delete();

REVOKE ALL ON FUNCTION public.guard_asset_retained_delete()
  FROM PUBLIC, anon, authenticated, service_role;

CREATE TABLE accounting_private.asset_disposal_commands (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  company_id uuid NOT NULL REFERENCES public.companies(id) ON DELETE RESTRICT,
  asset_id uuid NOT NULL REFERENCES public.assets(id) ON DELETE RESTRICT,
  expected_asset_updated_at timestamptz NOT NULL,
  prepared_journal_entry_id uuid
    REFERENCES public.journal_entries(id) ON DELETE RESTRICT,
  fiscal_period_id uuid NOT NULL
    REFERENCES public.fiscal_periods(id) ON DELETE RESTRICT,
  disposal_type text NOT NULL,
  disposed_at date NOT NULL,
  disposed_proceeds numeric,
  proceeds_vat numeric,
  vat_treatment text,
  current_depreciation numeric,
  jamkning_amount numeric,
  jamkning_direction text,
  jamkning_remaining_years integer,
  jamkning_total_years integer,
  jamkning_original_input_vat numeric,
  jamkning_original_deduction_percent numeric,
  jamkning_new_deduction_percent numeric,
  actor_type text,
  actor_label text,
  voucher_number integer,
  voucher_series text,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT asset_disposal_commands_asset_unique UNIQUE (company_id, asset_id)
);

ALTER TABLE accounting_private.asset_disposal_commands ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE accounting_private.asset_disposal_commands
  FROM PUBLIC, anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION accounting_private.guard_asset_disposal_command_immutable()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'pg_catalog', 'public'
AS $function$
BEGIN
  RAISE EXCEPTION 'Asset disposal command identity is immutable'
    USING ERRCODE = '23514';
END;
$function$;

CREATE TRIGGER guard_asset_disposal_command_immutable
  BEFORE UPDATE OR DELETE ON accounting_private.asset_disposal_commands
  FOR EACH ROW EXECUTE FUNCTION accounting_private.guard_asset_disposal_command_immutable();

REVOKE ALL ON FUNCTION accounting_private.guard_asset_disposal_command_immutable()
  FROM PUBLIC, anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION public.commit_asset_disposal(
  p_company_id uuid,
  p_asset_id uuid,
  p_entry_id uuid,
  p_expected_asset_updated_at timestamptz,
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
SET search_path TO 'pg_catalog', 'public'
AS $function$
DECLARE
  v_claims jsonb := COALESCE(NULLIF(current_setting('request.jwt.claims', true), '')::jsonb, '{}'::jsonb);
  v_asset public.assets%ROWTYPE;
  v_command accounting_private.asset_disposal_commands%ROWTYPE;
  v_retry_probe integer;
  v_entry_user_id uuid;
  v_schedule_id uuid;
  v_schedule_entry_id uuid;
  v_period_start date;
  v_period_closed boolean;
  v_period_locked_at timestamptz;
  v_company_lock_date date;
  v_voucher_number integer;
  v_voucher_series text;
BEGIN
  IF COALESCE(v_claims ->> 'role', '') <> 'service_role' THEN
    RAISE EXCEPTION 'commit_asset_disposal is callable only by service_role'
      USING ERRCODE = '42501';
  END IF;

  IF p_company_id IS NULL OR p_asset_id IS NULL
     OR p_expected_asset_updated_at IS NULL OR p_fiscal_period_id IS NULL
     OR p_disposal_type IS NULL OR p_disposed_at IS NULL THEN
    RAISE EXCEPTION 'Asset disposal identity, expected version, type, and date are required'
      USING ERRCODE = '22004';
  END IF;

  FOR v_retry_probe IN 1..2 LOOP
    SELECT command.*
    INTO v_command
    FROM accounting_private.asset_disposal_commands command
    WHERE command.company_id = p_company_id
      AND command.asset_id = p_asset_id
    FOR UPDATE;

    IF FOUND THEN
      SELECT asset.*
      INTO v_asset
      FROM public.assets asset
      WHERE asset.id = p_asset_id
        AND asset.company_id = p_company_id
      FOR UPDATE;

      IF NOT FOUND
         OR v_command.expected_asset_updated_at IS DISTINCT FROM p_expected_asset_updated_at
         OR v_command.prepared_journal_entry_id IS DISTINCT FROM p_entry_id
         OR v_command.fiscal_period_id IS DISTINCT FROM p_fiscal_period_id
         OR v_command.disposal_type IS DISTINCT FROM p_disposal_type
         OR v_command.disposed_at IS DISTINCT FROM p_disposed_at
         OR v_command.disposed_proceeds IS DISTINCT FROM p_disposed_proceeds
         OR v_command.proceeds_vat IS DISTINCT FROM p_proceeds_vat
         OR v_command.vat_treatment IS DISTINCT FROM p_vat_treatment
         OR v_command.current_depreciation IS DISTINCT FROM p_current_depreciation
         OR v_command.jamkning_amount IS DISTINCT FROM p_jamkning_amount
         OR v_command.jamkning_direction IS DISTINCT FROM p_jamkning_direction
         OR v_command.jamkning_remaining_years IS DISTINCT FROM p_jamkning_remaining_years
         OR v_command.jamkning_total_years IS DISTINCT FROM p_jamkning_total_years
         OR v_command.jamkning_original_input_vat IS DISTINCT FROM p_jamkning_original_input_vat
         OR v_command.jamkning_original_deduction_percent IS DISTINCT FROM p_jamkning_original_deduction_percent
         OR v_command.jamkning_new_deduction_percent IS DISTINCT FROM p_jamkning_new_deduction_percent
         OR v_command.actor_type IS DISTINCT FROM p_actor_type
         OR v_command.actor_label IS DISTINCT FROM p_actor_label
         OR v_asset.disposed_at IS DISTINCT FROM p_disposed_at
         OR v_asset.disposed_proceeds IS DISTINCT FROM p_disposed_proceeds
         OR v_asset.disposed_proceeds_vat IS DISTINCT FROM p_proceeds_vat
         OR v_asset.disposed_vat_treatment IS DISTINCT FROM p_vat_treatment
         OR v_asset.disposal_type IS DISTINCT FROM p_disposal_type
         OR v_asset.disposal_journal_entry_id IS DISTINCT FROM p_entry_id
         OR v_asset.jamkning_amount IS DISTINCT FROM p_jamkning_amount
         OR v_asset.jamkning_direction IS DISTINCT FROM p_jamkning_direction
         OR v_asset.jamkning_remaining_years IS DISTINCT FROM p_jamkning_remaining_years
         OR v_asset.jamkning_total_years IS DISTINCT FROM p_jamkning_total_years
         OR v_asset.jamkning_original_input_vat IS DISTINCT FROM p_jamkning_original_input_vat
         OR v_asset.jamkning_original_deduction_percent IS DISTINCT FROM p_jamkning_original_deduction_percent
         OR v_asset.jamkning_new_deduction_percent IS DISTINCT FROM p_jamkning_new_deduction_percent
         OR v_asset.jamkning_remaining_months IS NOT NULL
         OR v_asset.jamkning_total_months IS NOT NULL
         OR (
           p_entry_id IS NULL
           AND (
             v_command.voucher_number IS NOT NULL
             OR v_command.voucher_series IS NOT NULL
           )
         )
         OR (
           p_entry_id IS NOT NULL
           AND NOT EXISTS (
             SELECT 1
             FROM public.journal_entries entry
             WHERE entry.id = p_entry_id
               AND entry.company_id = p_company_id
               AND entry.status = 'posted'
               AND entry.voucher_number IS NOT DISTINCT FROM v_command.voucher_number
               AND entry.voucher_series IS NOT DISTINCT FROM v_command.voucher_series
           )
         ) THEN
        RAISE EXCEPTION 'Stored asset disposal command conflicts with supplied identity or retained state'
          USING ERRCODE = '23514';
      END IF;

      RETURN QUERY SELECT v_command.voucher_number;
      RETURN;
    END IF;

    IF v_retry_probe = 1 THEN
      SELECT asset.*
      INTO v_asset
      FROM public.assets asset
      WHERE asset.id = p_asset_id
        AND asset.company_id = p_company_id
      FOR UPDATE;

      IF NOT FOUND THEN
        RAISE EXCEPTION 'Asset not found: %', p_asset_id USING ERRCODE = 'P0002';
      END IF;
      IF v_asset.disposed_at IS NULL THEN
        EXIT;
      END IF;
    ELSE
      RAISE EXCEPTION 'Asset is already disposed without an exact command identity: %', p_asset_id
        USING ERRCODE = '23514';
    END IF;
  END LOOP;

  IF p_disposal_type NOT IN ('sale', 'scrap', 'business_transfer') THEN
    RAISE EXCEPTION 'Unsupported asset disposal type: %', p_disposal_type
      USING ERRCODE = '23514';
  END IF;
  IF COALESCE(p_disposed_proceeds, 0) < 0 OR COALESCE(p_proceeds_vat, 0) < 0 THEN
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
  IF p_disposal_type = 'scrap' AND COALESCE(p_disposed_proceeds, 0) <> 0 THEN
    RAISE EXCEPTION 'Scrapping cannot carry proceeds'
      USING ERRCODE = '23514';
  END IF;

  -- The retry loop locked the undisposed asset before any fiscal-period,
  -- draft, schedule, voucher, or register mutation.
  IF v_asset.updated_at IS DISTINCT FROM p_expected_asset_updated_at THEN
    RAISE EXCEPTION 'Asset version changed before disposal: %', p_asset_id
      USING ERRCODE = '40001';
  END IF;

  IF p_entry_id IS NULL AND (
    abs(COALESCE(v_asset.acquisition_cost, 0)) > 0.005
    OR abs(COALESCE(p_disposed_proceeds, 0)) > 0.005
    OR abs(COALESCE(p_current_depreciation, 0)) > 0.005
  ) THEN
    RAISE EXCEPTION 'A financially material asset disposal requires a voucher'
      USING ERRCODE = '23514';
  END IF;

  SELECT period.period_start, period.is_closed, period.locked_at
  INTO v_period_start, v_period_closed, v_period_locked_at
  FROM public.fiscal_periods period
  WHERE period.id = p_fiscal_period_id
    AND period.company_id = p_company_id
    AND p_disposed_at BETWEEN period.period_start AND period.period_end
  FOR SHARE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Fiscal period does not contain disposal date'
      USING ERRCODE = '22007';
  END IF;
  IF v_period_closed OR v_period_locked_at IS NOT NULL THEN
    RAISE EXCEPTION 'Cannot dispose asset in a locked or closed fiscal period'
      USING ERRCODE = '23514';
  END IF;

  SELECT settings.bookkeeping_locked_through
  INTO v_company_lock_date
  FROM public.company_settings settings
  WHERE settings.company_id = p_company_id
  FOR SHARE;
  IF v_company_lock_date IS NOT NULL AND p_disposed_at <= v_company_lock_date THEN
    RAISE EXCEPTION 'Bookkeeping is locked through %', v_company_lock_date
      USING ERRCODE = '23514';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM public.depreciation_schedules schedule
    JOIN public.fiscal_periods period ON period.id = schedule.fiscal_period_id
    WHERE schedule.company_id = p_company_id
      AND schedule.asset_id = p_asset_id
      AND schedule.journal_entry_id IS NOT NULL
      AND period.period_start > v_period_start
  ) THEN
    RAISE EXCEPTION 'Later depreciation is already posted for asset %', p_asset_id
      USING ERRCODE = '23514';
  END IF;

  IF p_entry_id IS NOT NULL THEN
    SELECT entry.user_id
    INTO v_entry_user_id
    FROM public.journal_entries entry
    WHERE entry.id = p_entry_id
      AND entry.company_id = p_company_id
      AND entry.fiscal_period_id = p_fiscal_period_id
      AND entry.entry_date = p_disposed_at
      AND entry.status = 'draft'
      AND entry.source_type = 'system'
    FOR UPDATE;

    IF NOT FOUND THEN
      RAISE EXCEPTION 'Valid disposal draft not found: %', p_entry_id
        USING ERRCODE = 'P0002';
    END IF;
  END IF;

  IF COALESCE(p_current_depreciation, 0) > 0.005 THEN
    SELECT schedule.id, schedule.journal_entry_id
    INTO v_schedule_id, v_schedule_entry_id
    FROM public.depreciation_schedules schedule
    WHERE schedule.asset_id = p_asset_id
      AND schedule.fiscal_period_id = p_fiscal_period_id
    FOR UPDATE;

    IF FOUND AND v_schedule_entry_id IS NOT NULL THEN
      RAISE EXCEPTION 'Depreciation was posted concurrently for asset %', p_asset_id
        USING ERRCODE = '23514';
    ELSIF FOUND THEN
      UPDATE public.depreciation_schedules schedule
      SET planned_depreciation = p_current_depreciation,
          journal_entry_id = p_entry_id,
          posted_at = now()
      WHERE schedule.id = v_schedule_id;
    ELSE
      INSERT INTO public.depreciation_schedules (
        user_id, company_id, asset_id, fiscal_period_id,
        planned_depreciation, journal_entry_id, posted_at
      ) VALUES (
        COALESCE(v_entry_user_id, v_asset.user_id), p_company_id,
        p_asset_id, p_fiscal_period_id, p_current_depreciation,
        p_entry_id, now()
      );
    END IF;
  END IF;

  IF p_entry_id IS NOT NULL THEN
    SELECT committed.voucher_number
    INTO v_voucher_number
    FROM public.commit_journal_entry(
      p_company_id, p_entry_id, 'user_accept', NULL,
      p_actor_type, p_actor_label
    ) committed;

    SELECT entry.voucher_series
    INTO v_voucher_series
    FROM public.journal_entries entry
    WHERE entry.id = p_entry_id
      AND entry.company_id = p_company_id
      AND entry.status = 'posted'
      AND entry.voucher_number IS NOT DISTINCT FROM v_voucher_number;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Committed disposal voucher identity is incomplete'
        USING ERRCODE = '55000';
    END IF;
  END IF;

  INSERT INTO accounting_private.asset_disposal_commands (
    company_id, asset_id, expected_asset_updated_at,
    prepared_journal_entry_id, fiscal_period_id, disposal_type, disposed_at,
    disposed_proceeds, proceeds_vat, vat_treatment, current_depreciation,
    jamkning_amount, jamkning_direction, jamkning_remaining_years,
    jamkning_total_years, jamkning_original_input_vat,
    jamkning_original_deduction_percent, jamkning_new_deduction_percent,
    actor_type, actor_label, voucher_number, voucher_series
  ) VALUES (
    p_company_id, p_asset_id, p_expected_asset_updated_at,
    p_entry_id, p_fiscal_period_id, p_disposal_type, p_disposed_at,
    p_disposed_proceeds, p_proceeds_vat, p_vat_treatment,
    p_current_depreciation, p_jamkning_amount, p_jamkning_direction,
    p_jamkning_remaining_years, p_jamkning_total_years,
    p_jamkning_original_input_vat, p_jamkning_original_deduction_percent,
    p_jamkning_new_deduction_percent, p_actor_type, p_actor_label,
    v_voucher_number, v_voucher_series
  );

  PERFORM accounting_private.grant_accounting_command_capability(
    'asset_disposal_transition', p_company_id, p_asset_id
  );
  UPDATE public.assets asset
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
  WHERE asset.id = p_asset_id
    AND asset.company_id = p_company_id
    AND asset.disposed_at IS NULL
    AND asset.updated_at IS NOT DISTINCT FROM p_expected_asset_updated_at;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Asset disposal lost its version boundary: %', p_asset_id
      USING ERRCODE = '40001';
  END IF;

  PERFORM accounting_private.revoke_accounting_command_capability(
    'asset_disposal_transition', p_company_id, p_asset_id
  );

  RETURN QUERY SELECT v_voucher_number;
END;
$function$;

REVOKE ALL ON FUNCTION public.commit_asset_disposal(
  uuid, uuid, uuid, timestamptz, uuid, text, date, numeric, numeric, text,
  numeric, numeric, text, integer, integer, numeric, numeric, numeric, text, text
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.commit_asset_disposal(
  uuid, uuid, uuid, timestamptz, uuid, text, date, numeric, numeric, text,
  numeric, numeric, text, integer, integer, numeric, numeric, numeric, text, text
) TO service_role;

COMMENT ON FUNCTION public.commit_asset_disposal(
  uuid, uuid, uuid, timestamptz, uuid, text, date, numeric, numeric, text,
  numeric, numeric, text, integer, integer, numeric, numeric, numeric, text, text
) IS 'Version-bound service-only atomic disposal of a fixed asset, its voucher, depreciation schedule, and retained register state.';

NOTIFY pgrst, 'reload schema';
