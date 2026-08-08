-- Legally compensate a categorization voucher in one database transaction.
-- The original row lock serializes concurrent compensation attempts. A new
-- storno is posted and linked before the original transitions posted to
-- reversed, so any failure rolls the whole operation back without an orphan.

CREATE OR REPLACE FUNCTION public.compensate_transaction_categorization(
  p_company_id uuid,
  p_transaction_id uuid,
  p_original_journal_entry_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_jwt_role text := coalesce(
    nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role',
    ''
  );
  v_original public.journal_entries%ROWTYPE;
  v_transaction_pointer uuid;
  v_reversal_ids uuid[] := ARRAY[]::uuid[];
  v_reversal_id uuid;
  v_pointer_cleared boolean;
  v_existing_count integer;
BEGIN
  IF v_jwt_role IN ('anon', 'authenticated') THEN
    IF NOT public.caller_is_company_member(p_company_id) THEN
      RAISE EXCEPTION 'unauthorized: caller is not a member of company %', p_company_id
        USING ERRCODE = '42501';
    END IF;
  END IF;

  SELECT je.*
    INTO v_original
    FROM public.journal_entries je
   WHERE je.id = p_original_journal_entry_id
     AND je.company_id = p_company_id
   FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Original categorization journal entry not found: %',
      p_original_journal_entry_id USING ERRCODE = 'P0002';
  END IF;

  IF v_original.source_type IS DISTINCT FROM 'bank_transaction'
     OR v_original.source_id IS DISTINCT FROM p_transaction_id THEN
    RAISE EXCEPTION 'Journal entry % is not the exact transaction source %',
      p_original_journal_entry_id, p_transaction_id USING ERRCODE = '22023';
  END IF;

  SELECT t.journal_entry_id
    INTO v_transaction_pointer
    FROM public.transactions t
   WHERE t.id = p_transaction_id
     AND t.company_id = p_company_id
   FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Categorized transaction not found: %', p_transaction_id
      USING ERRCODE = 'P0002';
  END IF;

  SELECT coalesce(array_agg(je.id ORDER BY je.created_at, je.id), ARRAY[]::uuid[])
    INTO v_reversal_ids
    FROM public.journal_entries je
   WHERE je.company_id = p_company_id
     AND je.reverses_id = p_original_journal_entry_id
     AND je.source_type = 'storno'
     AND je.status = 'posted';

  v_existing_count := coalesce(array_length(v_reversal_ids, 1), 0);

  IF v_existing_count > 1 THEN
    RETURN jsonb_build_object(
      'status', 'ambiguous_existing_reversals',
      'original_journal_entry_id', p_original_journal_entry_id,
      'reversal_journal_entry_ids', to_jsonb(v_reversal_ids),
      'original_pointer_cleared', v_transaction_pointer IS DISTINCT FROM p_original_journal_entry_id
    );
  END IF;

  -- A reverses_id link is only provenance, not proof that the posted entry is
  -- a legal storno. Compare both line multisets across every accounting field
  -- that the generated storno preserves or inverts. EXCEPT ALL is deliberate:
  -- ordinary EXCEPT would collapse duplicate lines and could adopt a partial
  -- or duplicated reversal that merely has the same distinct line values.
  IF v_existing_count = 1 AND EXISTS (
    WITH expected_lines AS (
      SELECT
        jel.account_number,
        jel.account_id,
        round(coalesce(jel.credit_amount, 0), 2) AS debit_amount,
        round(coalesce(jel.debit_amount, 0), 2) AS credit_amount,
        jel.currency,
        CASE
          WHEN jel.amount_in_currency IS NULL THEN NULL
          ELSE -jel.amount_in_currency
        END AS amount_in_currency,
        jel.exchange_rate,
        jel.sort_order,
        jel.tax_code,
        jel.dimensions
      FROM public.journal_entry_lines jel
      WHERE jel.journal_entry_id = p_original_journal_entry_id
    ),
    actual_lines AS (
      SELECT
        jel.account_number,
        jel.account_id,
        jel.debit_amount,
        jel.credit_amount,
        jel.currency,
        jel.amount_in_currency,
        jel.exchange_rate,
        jel.sort_order,
        jel.tax_code,
        jel.dimensions
      FROM public.journal_entry_lines jel
      WHERE jel.journal_entry_id = v_reversal_ids[1]
    )
    SELECT 1
    FROM (
      (
        SELECT * FROM expected_lines
        EXCEPT ALL
        SELECT * FROM actual_lines
      )
      UNION ALL
      (
        SELECT * FROM actual_lines
        EXCEPT ALL
        SELECT * FROM expected_lines
      )
    ) mismatched_lines
  ) THEN
    RETURN jsonb_build_object(
      'status', 'unverified_existing_reversal',
      'original_journal_entry_id', p_original_journal_entry_id,
      'reversal_journal_entry_ids', to_jsonb(v_reversal_ids),
      'original_pointer_cleared', false
    );
  END IF;

  IF v_original.status = 'reversed' THEN
    IF v_existing_count <> 1
       OR v_original.reversed_by_id IS DISTINCT FROM v_reversal_ids[1] THEN
      RETURN jsonb_build_object(
        'status', 'ambiguous_reversal_link',
        'original_journal_entry_id', p_original_journal_entry_id,
        'reversal_journal_entry_ids', to_jsonb(v_reversal_ids),
        'original_pointer_cleared', v_transaction_pointer IS DISTINCT FROM p_original_journal_entry_id
      );
    END IF;

    UPDATE public.transactions
       SET journal_entry_id = NULL
     WHERE id = p_transaction_id
       AND company_id = p_company_id
       AND journal_entry_id = p_original_journal_entry_id;

    SELECT t.journal_entry_id IS DISTINCT FROM p_original_journal_entry_id
      INTO v_pointer_cleared
      FROM public.transactions t
     WHERE t.id = p_transaction_id
       AND t.company_id = p_company_id;

    RETURN jsonb_build_object(
      'status', 'already_reversed',
      'original_journal_entry_id', p_original_journal_entry_id,
      'reversal_journal_entry_ids', to_jsonb(v_reversal_ids),
      'original_pointer_cleared', v_pointer_cleared
    );
  END IF;

  IF v_original.status IS DISTINCT FROM 'posted' THEN
    RAISE EXCEPTION 'Cannot compensate journal entry % with status %',
      p_original_journal_entry_id, v_original.status USING ERRCODE = '55000';
  END IF;

  IF v_existing_count = 1 THEN
    v_reversal_id := v_reversal_ids[1];
  ELSE
    INSERT INTO public.journal_entries (
      company_id,
      user_id,
      fiscal_period_id,
      voucher_number,
      voucher_series,
      entry_date,
      description,
      source_type,
      source_id,
      reverses_id,
      status
    ) VALUES (
      p_company_id,
      v_original.user_id,
      v_original.fiscal_period_id,
      0,
      coalesce(v_original.voucher_series, 'A'),
      v_original.entry_date,
      'Makulering: ' || v_original.description,
      'storno',
      v_original.source_id,
      p_original_journal_entry_id,
      'draft'
    )
    RETURNING id INTO v_reversal_id;

    INSERT INTO public.journal_entry_lines (
      journal_entry_id,
      account_number,
      account_id,
      debit_amount,
      credit_amount,
      currency,
      amount_in_currency,
      exchange_rate,
      line_description,
      sort_order,
      tax_code,
      dimensions
    )
    SELECT
      v_reversal_id,
      jel.account_number,
      jel.account_id,
      round(coalesce(jel.credit_amount, 0), 2),
      round(coalesce(jel.debit_amount, 0), 2),
      jel.currency,
      CASE
        WHEN jel.amount_in_currency IS NULL THEN NULL
        ELSE -jel.amount_in_currency
      END,
      jel.exchange_rate,
      'Makulering: ' || coalesce(jel.line_description, ''),
      jel.sort_order,
      jel.tax_code,
      jel.dimensions
    FROM public.journal_entry_lines jel
    WHERE jel.journal_entry_id = p_original_journal_entry_id;

    PERFORM * FROM public.commit_journal_entry(
      p_company_id,
      v_reversal_id,
      NULL,
      NULL,
      'system',
      'categorization_compensation'
    );

    v_reversal_ids := ARRAY[v_reversal_id];
  END IF;

  UPDATE public.journal_entries
     SET status = 'reversed',
         reversed_by_id = v_reversal_id
   WHERE id = p_original_journal_entry_id
     AND company_id = p_company_id
     AND status = 'posted';

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Original categorization journal entry changed during compensation: %',
      p_original_journal_entry_id USING ERRCODE = '40001';
  END IF;

  UPDATE public.transactions
     SET journal_entry_id = NULL
   WHERE id = p_transaction_id
     AND company_id = p_company_id
     AND journal_entry_id = p_original_journal_entry_id;

  SELECT t.journal_entry_id IS DISTINCT FROM p_original_journal_entry_id
    INTO v_pointer_cleared
    FROM public.transactions t
   WHERE t.id = p_transaction_id
     AND t.company_id = p_company_id;

  RETURN jsonb_build_object(
    'status', CASE WHEN v_existing_count = 1
      THEN 'recovered_existing_reversal'
      ELSE 'reversed'
    END,
    'original_journal_entry_id', p_original_journal_entry_id,
    'reversal_journal_entry_ids', to_jsonb(v_reversal_ids),
    'original_pointer_cleared', v_pointer_cleared
  );
END;
$$;

REVOKE ALL ON FUNCTION public.compensate_transaction_categorization(
  uuid, uuid, uuid
) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.compensate_transaction_categorization(
  uuid, uuid, uuid
) TO authenticated, service_role;

COMMENT ON FUNCTION public.compensate_transaction_categorization(uuid, uuid, uuid) IS
  'Atomically stornoes the exact bank-transaction journal and clears its transaction pointer.';

NOTIFY pgrst, 'reload schema';
