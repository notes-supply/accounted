-- WP5 M4 atomic transaction categorization attachment.
-- Symbolic draft: allocate a numeric migration version only at candidate freeze.
-- Depends on 20260815130100_journal_lineage_publication.sql.

ALTER TABLE public.journal_entries
  ADD COLUMN categorization_category text,
  ADD COLUMN categorization_is_business boolean;

ALTER TABLE public.journal_entries
  ADD CONSTRAINT journal_entries_categorization_metadata_coherent
  CHECK (
    (categorization_category IS NULL AND categorization_is_business IS NULL)
    OR (
      categorization_category IS NOT NULL
      AND categorization_is_business IS NOT NULL
      AND source_type = 'bank_transaction'
      AND categorization_category IN (
        'income_services', 'income_products', 'income_other',
        'expense_equipment', 'expense_software', 'expense_travel',
        'expense_office', 'expense_marketing', 'expense_professional_services',
        'expense_education', 'expense_representation', 'expense_consumables',
        'expense_vehicle', 'expense_telecom', 'expense_bank_fees',
        'expense_card_fees', 'expense_currency_exchange', 'expense_other',
        'private', 'uncategorized'
      )
      AND categorization_is_business = (categorization_category <> 'private')
    )
  );

COMMENT ON COLUMN public.journal_entries.categorization_category IS
  'Immutable approved transaction category staged on the voucher before posting and verified during attachment.';
COMMENT ON COLUMN public.journal_entries.categorization_is_business IS
  'Immutable approved business or private classification staged on the voucher before posting and verified during attachment.';

-- Only M4 and M5 may attach or clear a bank categorization voucher pointer.
-- Other transaction pointer changes retain their current behavior.
CREATE OR REPLACE FUNCTION public.guard_transaction_categorization_pointer()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'pg_catalog', 'public'
AS $function$
DECLARE
  v_action text;
BEGIN
  IF NEW.journal_entry_id IS NOT DISTINCT FROM OLD.journal_entry_id THEN
    RETURN NEW;
  END IF;

  IF EXISTS (
    SELECT 1
    FROM public.journal_entries entry
    WHERE entry.id IN (OLD.journal_entry_id, NEW.journal_entry_id)
      AND entry.company_id = OLD.company_id
      AND entry.source_type = 'bank_transaction'
  ) THEN
    v_action := CASE
      WHEN OLD.journal_entry_id IS NULL AND NEW.journal_entry_id IS NOT NULL
        THEN 'transaction_categorization_attach'
      WHEN OLD.journal_entry_id IS NOT NULL AND NEW.journal_entry_id IS NULL
        THEN 'transaction_categorization_clear'
      ELSE NULL
    END;

    IF v_action IS NULL OR NOT accounting_private.has_accounting_command_capability(
      v_action, OLD.company_id, OLD.id
    ) THEN
      RAISE EXCEPTION 'Bank categorization pointers may change only through the atomic attachment or compensation RPC'
        USING ERRCODE = '23514';
    END IF;
  END IF;

  RETURN NEW;
END;
$function$;

CREATE TRIGGER guard_transaction_categorization_pointer
  BEFORE UPDATE OF journal_entry_id ON public.transactions
  FOR EACH ROW EXECUTE FUNCTION public.guard_transaction_categorization_pointer();

REVOKE ALL ON FUNCTION public.guard_transaction_categorization_pointer()
  FROM PUBLIC, anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION public.categorization_snapshot_lines_match(
  p_journal_entry_id uuid,
  p_expected_lines jsonb
)
RETURNS boolean
LANGUAGE plpgsql
STABLE
SECURITY INVOKER
SET search_path TO 'pg_catalog', 'public'
AS $function$
BEGIN
  IF jsonb_typeof(p_expected_lines) IS DISTINCT FROM 'array'
     OR jsonb_array_length(p_expected_lines) = 0 THEN
    RETURN false;
  END IF;

  IF EXISTS (
    SELECT 1
    FROM jsonb_array_elements(p_expected_lines) expected(line)
    WHERE jsonb_typeof(expected.line) IS DISTINCT FROM 'object'
       OR jsonb_typeof(expected.line -> 'account_number') IS DISTINCT FROM 'string'
       OR NULLIF(expected.line ->> 'account_number', '') IS NULL
       OR jsonb_typeof(expected.line -> 'debit_amount') IS DISTINCT FROM 'number'
       OR jsonb_typeof(expected.line -> 'credit_amount') IS DISTINCT FROM 'number'
       OR (
         expected.line ? 'line_description'
         AND jsonb_typeof(expected.line -> 'line_description') NOT IN ('string', 'null')
       )
       OR (
         expected.line ? 'dimensions'
         AND jsonb_typeof(expected.line -> 'dimensions') IS DISTINCT FROM 'object'
       )
  ) THEN
    RETURN false;
  END IF;

  IF EXISTS (
    SELECT 1
    FROM jsonb_array_elements(p_expected_lines) expected(line)
    CROSS JOIN LATERAL jsonb_each(COALESCE(expected.line -> 'dimensions', '{}'::jsonb)) dimension
    WHERE jsonb_typeof(dimension.value) IS DISTINCT FROM 'string'
  ) THEN
    RETURN false;
  END IF;

  IF EXISTS (
    SELECT 1
    FROM jsonb_array_elements(p_expected_lines) expected(line)
    WHERE (expected.line ->> 'debit_amount')::numeric < 0
       OR (expected.line ->> 'credit_amount')::numeric < 0
       OR (
         ((expected.line ->> 'debit_amount')::numeric > 0)::integer
         + ((expected.line ->> 'credit_amount')::numeric > 0)::integer
       ) <> 1
  ) THEN
    RETURN false;
  END IF;

  RETURN EXISTS (
    SELECT 1
    FROM public.journal_entry_lines line
    WHERE line.journal_entry_id = p_journal_entry_id
  ) AND NOT EXISTS (
    WITH expected AS (
      SELECT
        expected.line ->> 'account_number' AS account_number,
        round((expected.line ->> 'debit_amount')::numeric * 100) / 100 AS debit_amount,
        round((expected.line ->> 'credit_amount')::numeric * 100) / 100 AS credit_amount,
        expected.line ->> 'line_description' AS line_description,
        COALESCE(expected.line -> 'dimensions', '{}'::jsonb) AS dimensions
      FROM jsonb_array_elements(p_expected_lines) expected(line)
    ),
    actual AS (
      SELECT
        line.account_number,
        round(COALESCE(line.debit_amount, 0) * 100) / 100 AS debit_amount,
        round(COALESCE(line.credit_amount, 0) * 100) / 100 AS credit_amount,
        line.line_description,
        COALESCE(line.dimensions, '{}'::jsonb) AS dimensions
      FROM public.journal_entry_lines line
      WHERE line.journal_entry_id = p_journal_entry_id
    )
    SELECT 1
    FROM (
      (SELECT * FROM expected EXCEPT ALL SELECT * FROM actual)
      UNION ALL
      (SELECT * FROM actual EXCEPT ALL SELECT * FROM expected)
    ) mismatch
  );
END;
$function$;

REVOKE ALL ON FUNCTION public.categorization_snapshot_lines_match(uuid, jsonb)
  FROM PUBLIC, anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION public.attach_transaction_categorization(
  p_company_id uuid,
  p_transaction_id uuid,
  p_journal_entry_id uuid,
  p_user_id uuid,
  p_expected_journal_entry_id uuid,
  p_expected_cash_account_id uuid,
  p_expected_settlement_account text,
  p_expected_amount_sek numeric,
  p_expected_category text,
  p_expected_is_business boolean,
  p_expected_lines jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'pg_catalog', 'public'
AS $function$
DECLARE
  v_claims jsonb := COALESCE(NULLIF(current_setting('request.jwt.claims', true), '')::jsonb, '{}'::jsonb);
  v_role text := COALESCE(v_claims ->> 'role', '');
  v_transaction public.transactions%ROWTYPE;
  v_entry public.journal_entries%ROWTYPE;
  v_cash_account public.cash_accounts%ROWTYPE;
  v_amount_sek numeric;
  v_settlement_debit numeric;
  v_settlement_credit numeric;
  v_status text;
  v_updated_count integer;
  v_lines jsonb;
  v_cash_readback jsonb;
  v_readback jsonb;
  v_publication jsonb;
BEGIN
  IF p_company_id IS NULL OR p_transaction_id IS NULL
     OR p_journal_entry_id IS NULL OR p_user_id IS NULL
     OR p_expected_settlement_account IS NULL
     OR p_expected_amount_sek IS NULL OR p_expected_category IS NULL
     OR p_expected_is_business IS NULL OR p_expected_lines IS NULL THEN
    RAISE EXCEPTION 'Complete categorization attachment identity is required'
      USING ERRCODE = '22004';
  END IF;

  IF v_role = 'authenticated' THEN
    IF auth.uid() IS DISTINCT FROM p_user_id
       OR public.current_active_company_id() IS DISTINCT FROM p_company_id
       OR NOT public.current_user_can_write()
       OR NOT public.caller_is_company_member(p_company_id) THEN
      RAISE EXCEPTION 'Unauthorized transaction categorization attachment'
        USING ERRCODE = '42501';
    END IF;
  ELSIF v_role = 'service_role' THEN
    IF NOT EXISTS (
      SELECT 1
      FROM public.company_members member
      WHERE member.company_id = p_company_id
        AND member.user_id = p_user_id
    ) THEN
      RAISE EXCEPTION 'Categorization publication user is not a company member'
        USING ERRCODE = '42501';
    END IF;
  ELSE
    RAISE EXCEPTION 'Unauthorized transaction categorization caller'
      USING ERRCODE = '42501';
  END IF;

  IF p_expected_category NOT IN (
    'income_services', 'income_products', 'income_other',
    'expense_equipment', 'expense_software', 'expense_travel',
    'expense_office', 'expense_marketing', 'expense_professional_services',
    'expense_education', 'expense_representation', 'expense_consumables',
    'expense_vehicle', 'expense_telecom', 'expense_bank_fees',
    'expense_card_fees', 'expense_currency_exchange', 'expense_other',
    'private', 'uncategorized'
  ) OR p_expected_is_business IS DISTINCT FROM (p_expected_category <> 'private')
     OR round(p_expected_amount_sek * 100) / 100 <= 0 THEN
    RAISE EXCEPTION 'Invalid categorization snapshot'
      USING ERRCODE = '22023';
  END IF;

  SELECT * INTO v_transaction
  FROM public.transactions transaction_row
  WHERE transaction_row.id = p_transaction_id
    AND transaction_row.company_id = p_company_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Categorization transaction not found: %', p_transaction_id
      USING ERRCODE = 'P0002';
  END IF;

  IF upper(COALESCE(v_transaction.currency, 'SEK')) = 'SEK' THEN
    v_amount_sek := round(abs(v_transaction.amount) * 100) / 100;
  ELSIF v_transaction.amount_sek IS NOT NULL THEN
    v_amount_sek := round(abs(v_transaction.amount_sek) * 100) / 100;
  ELSIF v_transaction.exchange_rate IS NOT NULL
        AND v_transaction.exchange_rate > 0 THEN
    v_amount_sek := round(
      abs(v_transaction.amount * v_transaction.exchange_rate) * 100
    ) / 100;
  ELSE
    RAISE EXCEPTION 'Transaction has no authoritative SEK amount'
      USING ERRCODE = '23514';
  END IF;

  IF v_transaction.cash_account_id IS DISTINCT FROM p_expected_cash_account_id
     OR v_amount_sek IS DISTINCT FROM round(p_expected_amount_sek * 100) / 100 THEN
    RAISE EXCEPTION 'Categorization transaction snapshot drifted'
      USING ERRCODE = '40001';
  END IF;

  IF p_expected_cash_account_id IS NULL THEN
    IF p_expected_settlement_account IS DISTINCT FROM '1930' THEN
      RAISE EXCEPTION 'Unbound categorization requires the legacy 1930 settlement account'
        USING ERRCODE = '23514';
    END IF;
    v_cash_readback := NULL;
  ELSE
    SELECT * INTO v_cash_account
    FROM public.cash_accounts cash_account
    WHERE cash_account.id = p_expected_cash_account_id
      AND cash_account.company_id = p_company_id
    FOR SHARE;
    IF NOT FOUND
       OR v_cash_account.ledger_account IS DISTINCT FROM p_expected_settlement_account THEN
      RAISE EXCEPTION 'Categorization cash-account provenance drifted'
        USING ERRCODE = '40001';
    END IF;
    v_cash_readback := jsonb_build_object(
      'id', v_cash_account.id,
      'companyId', v_cash_account.company_id,
      'ledgerAccount', v_cash_account.ledger_account
    );
  END IF;

  SELECT * INTO v_entry
  FROM public.journal_entries entry
  WHERE entry.id = p_journal_entry_id
    AND entry.company_id = p_company_id
  FOR SHARE;
  IF NOT FOUND OR v_entry.user_id IS DISTINCT FROM p_user_id
     OR v_entry.status IS DISTINCT FROM 'posted'
     OR v_entry.source_type IS DISTINCT FROM 'bank_transaction'
     OR v_entry.source_id IS DISTINCT FROM p_transaction_id
     OR v_entry.categorization_category IS DISTINCT FROM p_expected_category
     OR v_entry.categorization_is_business IS DISTINCT FROM p_expected_is_business
     OR NOT public.categorization_snapshot_lines_match(
       p_journal_entry_id, p_expected_lines
     ) THEN
    RAISE EXCEPTION 'Posted categorization voucher does not match the approved snapshot'
      USING ERRCODE = '23514';
  END IF;

  SELECT
    round(COALESCE(sum(line.debit_amount), 0) * 100) / 100,
    round(COALESCE(sum(line.credit_amount), 0) * 100) / 100
  INTO v_settlement_debit, v_settlement_credit
  FROM public.journal_entry_lines line
  WHERE line.journal_entry_id = p_journal_entry_id
    AND line.account_number = p_expected_settlement_account;

  IF v_transaction.amount < 0 THEN
    IF v_settlement_debit <> 0 OR v_settlement_credit <> v_amount_sek THEN
      RAISE EXCEPTION 'Posted categorization settlement leg does not match the transaction'
        USING ERRCODE = '23514';
    END IF;
  ELSIF v_transaction.amount > 0 THEN
    IF v_settlement_debit <> v_amount_sek OR v_settlement_credit <> 0 THEN
      RAISE EXCEPTION 'Posted categorization settlement leg does not match the transaction'
        USING ERRCODE = '23514';
    END IF;
  ELSE
    RAISE EXCEPTION 'Zero-value transaction cannot be categorized'
      USING ERRCODE = '23514';
  END IF;

  IF v_transaction.journal_entry_id IS NOT DISTINCT FROM p_journal_entry_id THEN
    IF v_transaction.category IS DISTINCT FROM p_expected_category
       OR v_transaction.is_business IS DISTINCT FROM p_expected_is_business THEN
      RAISE EXCEPTION 'Existing categorization attachment is contradictory'
        USING ERRCODE = '23514';
    END IF;
    v_status := 'already_applied';
  ELSIF v_transaction.journal_entry_id IS NOT DISTINCT FROM p_expected_journal_entry_id THEN
    PERFORM accounting_private.grant_accounting_command_capability(
      'transaction_categorization_attach', p_company_id, p_transaction_id
    );
    UPDATE public.transactions transaction_row
    SET is_business = p_expected_is_business,
        category = p_expected_category,
        journal_entry_id = p_journal_entry_id
    WHERE transaction_row.id = p_transaction_id
      AND transaction_row.company_id = p_company_id
      AND transaction_row.journal_entry_id IS NOT DISTINCT FROM p_expected_journal_entry_id
      AND transaction_row.cash_account_id IS NOT DISTINCT FROM p_expected_cash_account_id;
    GET DIAGNOSTICS v_updated_count = ROW_COUNT;
    IF v_updated_count IS DISTINCT FROM 1 THEN
      RAISE EXCEPTION 'Categorization attachment lost its compare-and-set'
        USING ERRCODE = '40001';
    END IF;
    PERFORM accounting_private.revoke_accounting_command_capability(
      'transaction_categorization_attach', p_company_id, p_transaction_id
    );
    v_status := 'applied';
  ELSE
    RAISE EXCEPTION 'Categorization accounting pointer drifted'
      USING ERRCODE = '40001';
  END IF;

  SELECT * INTO v_transaction
  FROM public.transactions transaction_row
  WHERE transaction_row.id = p_transaction_id
    AND transaction_row.company_id = p_company_id
    AND transaction_row.journal_entry_id = p_journal_entry_id
    AND transaction_row.cash_account_id IS NOT DISTINCT FROM p_expected_cash_account_id
    AND transaction_row.category IS NOT DISTINCT FROM p_expected_category
    AND transaction_row.is_business IS NOT DISTINCT FROM p_expected_is_business
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Categorization authoritative readback is contradictory'
      USING ERRCODE = '55000';
  END IF;

  SELECT jsonb_agg(
    jsonb_build_object(
      'account_number', line.account_number,
      'debit_amount', round(COALESCE(line.debit_amount, 0) * 100) / 100,
      'credit_amount', round(COALESCE(line.credit_amount, 0) * 100) / 100,
      'line_description', line.line_description,
      'dimensions', COALESCE(line.dimensions, '{}'::jsonb)
    )
    ORDER BY line.sort_order, line.id
  )
  INTO v_lines
  FROM public.journal_entry_lines line
  WHERE line.journal_entry_id = p_journal_entry_id;

  v_readback := jsonb_build_object(
    'transaction', jsonb_build_object(
      'id', v_transaction.id,
      'companyId', v_transaction.company_id,
      'journalEntryId', v_transaction.journal_entry_id,
      'cashAccountId', v_transaction.cash_account_id,
      'amountSek', v_amount_sek,
      'category', v_transaction.category,
      'isBusiness', v_transaction.is_business
    ),
    'journalEntry', jsonb_build_object(
      'id', v_entry.id,
      'companyId', v_entry.company_id,
      'status', v_entry.status,
      'sourceType', v_entry.source_type,
      'sourceId', v_entry.source_id,
      'category', v_entry.categorization_category,
      'isBusiness', v_entry.categorization_is_business,
      'lines', v_lines
    ),
    'cashAccount', v_cash_readback
  );

  v_publication := public.record_accounting_publication(
    p_company_id,
    'journal:' || v_entry.id::text || ':committed',
    'journal_entry.committed',
    v_entry.id,
    p_user_id,
    jsonb_build_object(
      'companyId', p_company_id,
      'userId', p_user_id,
      'entry', public.accounting_journal_entry_event_object(
        p_company_id, v_entry.id
      )
    )
  );

  RETURN jsonb_build_object(
    'status', v_status,
    'company_id', p_company_id,
    'transaction_id', p_transaction_id,
    'journal_entry_id', p_journal_entry_id,
    'readback', v_readback,
    'publication', jsonb_build_object(
      'publication_id', v_publication ->> 'publication_id',
      'event_key', 'journal:' || v_entry.id::text || ':committed',
      'event_type', 'journal_entry.committed'
    )
  );
END;
$function$;

REVOKE ALL ON FUNCTION public.attach_transaction_categorization(
  uuid, uuid, uuid, uuid, uuid, uuid, text, numeric, text, boolean, jsonb
) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.attach_transaction_categorization(
  uuid, uuid, uuid, uuid, uuid, uuid, text, numeric, text, boolean, jsonb
) TO authenticated, service_role;

NOTIFY pgrst, 'reload schema';
