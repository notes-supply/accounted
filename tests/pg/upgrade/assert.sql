-- Upgrade-path assertions: run AFTER the pull request's migrations have been
-- applied on top of the seeded database.
--
-- Every check raises an exception on failure, so `psql -v ON_ERROR_STOP=1`
-- fails the job. Keep the assertions about invariants that must hold for ANY
-- migration, not about the specifics of one change.

DO $$
DECLARE
  v_entries       INT;
  v_lines         INT;
  v_debits        NUMERIC;
  v_credits       NUMERIC;
  v_ore           NUMERIC;
  v_company       INT;
  v_period        INT;
  v_max_voucher   INT;
  v_payment_rows  INT;
  v_payment_exact INT;
BEGIN
  -- 1. The company, its membership and its fiscal period survived.
  SELECT count(*) INTO v_company
    FROM public.companies WHERE id = '22222222-2222-2222-2222-222222222222';
  IF v_company <> 1 THEN
    RAISE EXCEPTION 'upgrade: seeded company disappeared (found %)', v_company;
  END IF;

  SELECT count(*) INTO v_period
    FROM public.fiscal_periods WHERE id = '33333333-3333-3333-3333-333333333333';
  IF v_period <> 1 THEN
    RAISE EXCEPTION 'upgrade: seeded fiscal period disappeared (found %)', v_period;
  END IF;

  -- 2. All four posted verifikat survived, still posted. A migration must
  --    never silently drop or unpost a posted entry (BFL 5 kap).
  SELECT count(*) INTO v_entries
    FROM public.journal_entries
    WHERE company_id = '22222222-2222-2222-2222-222222222222'
      AND status = 'posted';
  IF v_entries <> 4 THEN
    RAISE EXCEPTION 'upgrade: expected 4 posted entries after migration, found %', v_entries;
  END IF;

  -- 3. Every line survived.
  SELECT count(*) INTO v_lines
    FROM public.journal_entry_lines l
    JOIN public.journal_entries e ON e.id = l.journal_entry_id
    WHERE e.company_id = '22222222-2222-2222-2222-222222222222';
  IF v_lines <> 9 THEN
    RAISE EXCEPTION 'upgrade: expected 9 journal entry lines after migration, found %', v_lines;
  END IF;

  -- 4. The ledger still balances. This is the assertion that catches a
  --    migration which retypes, rescales or rounds a money column.
  SELECT COALESCE(sum(l.debit_amount), 0), COALESCE(sum(l.credit_amount), 0)
    INTO v_debits, v_credits
    FROM public.journal_entry_lines l
    JOIN public.journal_entries e ON e.id = l.journal_entry_id
    WHERE e.company_id = '22222222-2222-2222-2222-222222222222';
  IF v_debits <> v_credits THEN
    RAISE EXCEPTION 'upgrade: ledger no longer balances after migration (debits %, credits %)',
      v_debits, v_credits;
  END IF;
  IF v_debits <> 20746.90 THEN
    RAISE EXCEPTION 'upgrade: total debits changed from 20746.90 to %', v_debits;
  END IF;

  -- 5. The öre survived exactly. Money is NUMERIC and must not drift.
  SELECT l.debit_amount INTO v_ore
    FROM public.journal_entry_lines l
    WHERE l.journal_entry_id = '44444444-4444-4444-4444-444444444403'
      AND l.account_number = '6570';
  IF v_ore IS DISTINCT FROM 123.45 THEN
    RAISE EXCEPTION 'upgrade: öre-level amount drifted from 123.45 to %', v_ore;
  END IF;

  -- 6. Voucher numbers are intact and still sequential from 1.
  SELECT max(voucher_number) INTO v_max_voucher
    FROM public.journal_entries
    WHERE company_id = '22222222-2222-2222-2222-222222222222';
  IF v_max_voucher <> 4 THEN
    RAISE EXCEPTION 'upgrade: highest voucher number changed to %, expected 4', v_max_voucher;
  END IF;

  -- 7. Both exact pre-migration supplier payment allocations survived active
  --    and unchanged. Their shared journal/invoice pair pins the upgrade-safe
  --    contract for legal history created before prospective duplicate guards.
  SELECT count(*) INTO v_payment_rows
    FROM public.supplier_invoice_payments
    WHERE supplier_invoice_id = '66666666-6666-6666-6666-666666666666';
  IF v_payment_rows <> 2 THEN
    RAISE EXCEPTION 'upgrade: expected 2 retained supplier payment allocations, found %',
      v_payment_rows;
  END IF;

  SELECT count(*) INTO v_payment_exact
    FROM public.supplier_invoice_payments
    WHERE company_id = '22222222-2222-2222-2222-222222222222'
      AND supplier_invoice_id = '66666666-6666-6666-6666-666666666666'
      AND payment_date = DATE '2026-04-15'
      AND currency = 'SEK'
      AND exchange_rate IS NULL
      AND exchange_rate_difference = 0
      AND journal_entry_id = '44444444-4444-4444-4444-444444444404'
      AND transaction_id IS NULL
      AND reversed_at IS NULL
      AND reversed_by_journal_entry_id IS NULL
      AND (
        (
          id = '77777777-7777-7777-7777-777777777701'
          AND amount = 100.00
          AND notes = 'Upgrade allocation 1'
          AND created_at = TIMESTAMPTZ '2026-04-15T12:00:00Z'
        )
        OR (
          id = '77777777-7777-7777-7777-777777777702'
          AND amount = 23.45
          AND notes = 'Upgrade allocation 2'
          AND created_at = TIMESTAMPTZ '2026-04-15T12:01:00Z'
        )
      );
  IF v_payment_exact <> 2 THEN
    RAISE EXCEPTION 'upgrade: exact supplier payment allocation fields changed (% of 2 exact)',
      v_payment_exact;
  END IF;

  RAISE NOTICE 'upgrade-path assertions passed: % entries, % lines, % retained supplier payments, balanced at %',
    v_entries, v_lines, v_payment_exact, v_debits;
END $$;
