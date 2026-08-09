-- Attach a categorized transaction only while its complete settlement
-- provenance still matches. The cash-account row lock serializes this check
-- against setLedgerAccount updates, closing the same-id ledger remap race.
--
-- SECURITY INVOKER preserves the caller's RLS. Cookie-session callers must
-- have write access to the active company; API-key callers use the existing
-- service-role client and remain explicitly company-scoped by every predicate.

ALTER TABLE public.journal_entries
  ADD COLUMN IF NOT EXISTS categorization_category text,
  ADD COLUMN IF NOT EXISTS categorization_is_business boolean;

ALTER TABLE public.journal_entries
  DROP CONSTRAINT IF EXISTS journal_entries_categorization_metadata_coherent;
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
  'Immutable approved transaction category used to authorize atomic attachment.';
COMMENT ON COLUMN public.journal_entries.categorization_is_business IS
  'Immutable approved business/private flag used to authorize atomic attachment.';

CREATE OR REPLACE FUNCTION public.attach_transaction_categorization(
  p_company_id uuid,
  p_transaction_id uuid,
  p_expected_journal_entry_id uuid,
  p_expected_cash_account_id uuid,
  p_expected_settlement_account text,
  p_is_business boolean,
  p_category text,
  p_journal_entry_id uuid
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $$
DECLARE
  v_jwt_role text := coalesce(
    nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role',
    ''
  );
  v_current_settlement_account text;
  v_transaction_amount numeric;
  v_transaction_amount_sek numeric;
  v_transaction_currency text;
  v_transaction_exchange_rate numeric;
  v_expected_amount_sek numeric;
  v_settlement_debit numeric;
  v_settlement_credit numeric;
  v_updated_count integer;
BEGIN
  IF v_jwt_role IN ('anon', 'authenticated') THEN
    IF NOT public.caller_is_company_member(p_company_id) THEN
      RETURN false;
    END IF;
  END IF;

  IF p_is_business IS DISTINCT FROM (p_category <> 'private') THEN
    RETURN false;
  END IF;

  -- Lock and validate the target row before inspecting its journal. The
  -- transaction sign defines the bank-leg direction, and its currency fields
  -- define the exact SEK amount that must appear in the posted journal.
  SELECT t.amount, t.amount_sek, t.currency, t.exchange_rate
    INTO v_transaction_amount, v_transaction_amount_sek,
         v_transaction_currency, v_transaction_exchange_rate
    FROM public.transactions t
   WHERE t.id = p_transaction_id
     AND t.company_id = p_company_id
     AND t.journal_entry_id IS NOT DISTINCT FROM p_expected_journal_entry_id
     AND t.cash_account_id IS NOT DISTINCT FROM p_expected_cash_account_id
   FOR UPDATE;

  IF NOT FOUND THEN
    RETURN false;
  END IF;

  IF p_expected_cash_account_id IS NULL THEN
    -- The 1930 fallback is valid only for a truly unbound legacy transaction.
    IF p_expected_settlement_account IS DISTINCT FROM '1930' THEN
      RETURN false;
    END IF;
  ELSE
    -- FOR SHARE conflicts with setLedgerAccount's UPDATE row lock. Whichever
    -- operation locks first becomes the linearization point: a remap that won
    -- first is observed here, while a later remap starts after attachment.
    SELECT ca.ledger_account
      INTO v_current_settlement_account
      FROM public.cash_accounts ca
     WHERE ca.id = p_expected_cash_account_id
       AND ca.company_id = p_company_id
     FOR SHARE;

    IF NOT FOUND
       OR v_current_settlement_account IS DISTINCT FROM p_expected_settlement_account THEN
      RETURN false;
    END IF;
  END IF;

  -- A non-null destination pointer must name the posted voucher created for
  -- this company. A null pointer preserves the existing partial categorization
  -- behavior when journal creation itself returned no entry.
  IF p_journal_entry_id IS NOT NULL
     AND NOT EXISTS (
       SELECT 1
         FROM public.journal_entries je
        WHERE je.id = p_journal_entry_id
          AND je.company_id = p_company_id
          AND je.status = 'posted'
          AND je.source_type = 'bank_transaction'
          AND je.source_id = p_transaction_id
          AND je.categorization_category = p_category
          AND je.categorization_is_business = p_is_business
     ) THEN
    RETURN false;
  END IF;

  IF p_journal_entry_id IS NOT NULL THEN
    IF coalesce(v_transaction_currency, 'SEK') = 'SEK' THEN
      v_expected_amount_sek := round(abs(v_transaction_amount), 2);
    ELSIF v_transaction_amount_sek IS NOT NULL THEN
      v_expected_amount_sek := round(abs(v_transaction_amount_sek), 2);
    ELSIF v_transaction_exchange_rate IS NOT NULL
          AND v_transaction_exchange_rate > 0 THEN
      v_expected_amount_sek := round(
        abs(v_transaction_amount * v_transaction_exchange_rate),
        2
      );
    ELSE
      RETURN false;
    END IF;

    IF v_expected_amount_sek <= 0 THEN
      RETURN false;
    END IF;

    SELECT round(coalesce(sum(jel.debit_amount), 0), 2),
           round(coalesce(sum(jel.credit_amount), 0), 2)
      INTO v_settlement_debit, v_settlement_credit
      FROM public.journal_entry_lines jel
     WHERE jel.journal_entry_id = p_journal_entry_id
       AND jel.account_number = p_expected_settlement_account;

    IF v_transaction_amount < 0 THEN
      IF v_settlement_debit <> 0
         OR v_settlement_credit <> v_expected_amount_sek THEN
        RETURN false;
      END IF;
    ELSIF v_transaction_amount > 0 THEN
      IF v_settlement_debit <> v_expected_amount_sek
         OR v_settlement_credit <> 0 THEN
        RETURN false;
      END IF;
    ELSE
      RETURN false;
    END IF;
  END IF;

  UPDATE public.transactions t
     SET is_business = p_is_business,
         category = p_category,
         journal_entry_id = p_journal_entry_id
   WHERE t.id = p_transaction_id
     AND t.company_id = p_company_id
     AND t.journal_entry_id IS NOT DISTINCT FROM p_expected_journal_entry_id
     AND t.cash_account_id IS NOT DISTINCT FROM p_expected_cash_account_id;

  GET DIAGNOSTICS v_updated_count = ROW_COUNT;
  RETURN v_updated_count = 1;
END;
$$;

REVOKE ALL ON FUNCTION public.attach_transaction_categorization(
  uuid, uuid, uuid, uuid, text, boolean, text, uuid
) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.attach_transaction_categorization(
  uuid, uuid, uuid, uuid, text, boolean, text, uuid
) TO authenticated, service_role;

NOTIFY pgrst, 'reload schema';
