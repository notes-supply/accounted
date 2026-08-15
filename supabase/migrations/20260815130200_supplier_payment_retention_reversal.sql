-- WP5 M3 supplier payment retention and atomic reversal.
-- Symbolic draft: allocate a numeric migration version only at candidate freeze.
-- Depends on 20260815130100_journal_lineage_publication.sql.

-- Immutable evidence for allocations removed from the active table by the
-- trusted reversal command. original_payment_id is the original active row ID.
CREATE TABLE public.supplier_invoice_payment_history (
  id uuid PRIMARY KEY,
  original_payment_id uuid NOT NULL UNIQUE,
  company_id uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  supplier_invoice_id uuid NOT NULL REFERENCES public.supplier_invoices(id) ON DELETE RESTRICT,
  allocation_owner_user_id uuid NOT NULL,
  payment_date date NOT NULL,
  amount numeric NOT NULL,
  currency text NOT NULL,
  exchange_rate numeric,
  exchange_rate_difference numeric,
  payment_exchange_rate numeric,
  journal_entry_id uuid NOT NULL REFERENCES public.journal_entries(id) ON DELETE RESTRICT,
  transaction_id uuid REFERENCES public.transactions(id) ON DELETE RESTRICT,
  notes text,
  allocation_created_at timestamptz NOT NULL,
  lineage_root_journal_entry_id uuid NOT NULL REFERENCES public.journal_entries(id) ON DELETE RESTRICT,
  reversed_live_journal_entry_id uuid NOT NULL REFERENCES public.journal_entries(id) ON DELETE RESTRICT,
  reversed_by_journal_entry_id uuid NOT NULL REFERENCES public.journal_entries(id) ON DELETE RESTRICT,
  reversal_command_id uuid NOT NULL,
  reversed_at timestamptz NOT NULL,
  reversal_actor_type text NOT NULL,
  reversal_actor_id uuid,
  reversal_actor_label text,
  CONSTRAINT supplier_payment_history_identity CHECK (id = original_payment_id),
  CONSTRAINT supplier_payment_history_amount_positive CHECK (amount > 0),
  CONSTRAINT supplier_payment_history_actor_type CHECK (
    reversal_actor_type IN ('user', 'api_key', 'mcp_oauth', 'cron', 'system', 'agent_chat')
  )
);

CREATE TABLE public.supplier_payment_reversals (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  company_id uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  requested_journal_entry_id uuid NOT NULL REFERENCES public.journal_entries(id) ON DELETE RESTRICT,
  root_journal_entry_id uuid NOT NULL REFERENCES public.journal_entries(id) ON DELETE RESTRICT,
  allocation_owner_journal_entry_id uuid NOT NULL REFERENCES public.journal_entries(id) ON DELETE RESTRICT,
  live_journal_entry_id uuid NOT NULL REFERENCES public.journal_entries(id) ON DELETE RESTRICT,
  reversal_journal_entry_id uuid NOT NULL REFERENCES public.journal_entries(id) ON DELETE RESTRICT,
  reversal_date date NOT NULL,
  reversal_fiscal_period_id uuid NOT NULL
    REFERENCES public.fiscal_periods(id) ON DELETE RESTRICT,
  publication_user_id uuid NOT NULL,
  actor_type text NOT NULL,
  actor_id uuid,
  actor_label text,
  allocation_count integer NOT NULL CHECK (allocation_count >= 0),
  committed_publication_id uuid REFERENCES public.accounting_publications(id) ON DELETE RESTRICT,
  reversed_publication_id uuid REFERENCES public.accounting_publications(id) ON DELETE RESTRICT,
  applied_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT supplier_payment_reversals_actor_type CHECK (
    actor_type IN ('user', 'api_key', 'mcp_oauth', 'cron', 'system', 'agent_chat')
  ),
  CONSTRAINT supplier_payment_reversals_root_unique UNIQUE (company_id, root_journal_entry_id),
  CONSTRAINT supplier_payment_reversals_requested_unique UNIQUE (company_id, requested_journal_entry_id),
  CONSTRAINT supplier_payment_reversals_storno_unique UNIQUE (reversal_journal_entry_id),
  CONSTRAINT supplier_payment_reversals_publications_pair CHECK (
    (committed_publication_id IS NULL AND reversed_publication_id IS NULL)
    OR (committed_publication_id IS NOT NULL AND reversed_publication_id IS NOT NULL)
  )
);

ALTER TABLE public.supplier_invoice_payment_history
  ADD CONSTRAINT supplier_payment_history_command_fkey
  FOREIGN KEY (reversal_command_id)
  REFERENCES public.supplier_payment_reversals(id) ON DELETE RESTRICT;

CREATE INDEX idx_supplier_payment_history_company_invoice
  ON public.supplier_invoice_payment_history (company_id, supplier_invoice_id);
CREATE INDEX idx_supplier_payment_history_company_root
  ON public.supplier_invoice_payment_history (company_id, lineage_root_journal_entry_id);
CREATE INDEX idx_supplier_payment_history_transaction
  ON public.supplier_invoice_payment_history (transaction_id)
  WHERE transaction_id IS NOT NULL;

ALTER TABLE public.supplier_invoice_payment_history ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.supplier_payment_reversals ENABLE ROW LEVEL SECURITY;

CREATE POLICY supplier_payment_history_select
  ON public.supplier_invoice_payment_history
  FOR SELECT TO authenticated
  USING (public.caller_is_company_member(company_id));

REVOKE ALL ON TABLE public.supplier_invoice_payment_history
  FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON TABLE public.supplier_invoice_payment_history
  TO authenticated, service_role;
REVOKE ALL ON TABLE public.supplier_payment_reversals
  FROM PUBLIC, anon, authenticated, service_role;

COMMENT ON TABLE public.supplier_invoice_payment_history IS
  'Immutable complete snapshots of supplier payment allocations moved out of the active table by an exact storno.';
COMMENT ON COLUMN public.supplier_invoice_payment_history.lineage_root_journal_entry_id IS
  'The stable accounting lineage root, distinct from journal_entry_id as the exact allocation-owning node and allocation_owner_user_id as the row owner.';
COMMENT ON COLUMN public.supplier_payment_reversals.allocation_owner_journal_entry_id IS
  'The one root or live-correction node whose exact active allocations were moved to immutable history.';

-- Current-schema actor resolution. Authenticated callers are pinned to
-- auth.uid(). Service callers must present a durable actor identity that can be
-- resolved to an auth user in the target company. The returned auth user is
-- used by M2 event_log and webhook payload identities; actor_id remains the
-- credential or subject identity supplied by the caller.
CREATE OR REPLACE FUNCTION public.resolve_supplier_reversal_actor(
  p_company_id uuid,
  p_actor_type text,
  p_actor_id uuid,
  p_actor_label text
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'pg_catalog', 'public'
AS $function$
DECLARE
  v_claims jsonb := COALESCE(NULLIF(current_setting('request.jwt.claims', true), '')::jsonb, '{}'::jsonb);
  v_role text := COALESCE(v_claims ->> 'role', '');
  v_actor_type text;
  v_actor_id uuid;
  v_actor_label text;
BEGIN
  IF p_company_id IS NULL THEN
    RAISE EXCEPTION 'Supplier reversal company is required' USING ERRCODE = '22004';
  END IF;

  IF v_role = 'authenticated' THEN
    v_actor_id := auth.uid();
    IF v_actor_id IS NULL
       OR public.current_active_company_id() IS DISTINCT FROM p_company_id
       OR NOT public.current_user_can_write()
       OR NOT EXISTS (
      SELECT 1
      FROM public.company_members member
      WHERE member.company_id = p_company_id
        AND member.user_id = v_actor_id
        AND member.role <> 'viewer'
    ) THEN
      RAISE EXCEPTION 'Unauthorized supplier payment reversal for company %', p_company_id
        USING ERRCODE = '42501';
    END IF;
    v_actor_type := 'user';
    v_actor_label := NULL;
  ELSIF v_role = 'service_role' THEN
    IF p_actor_type NOT IN ('user', 'api_key', 'mcp_oauth', 'cron', 'system', 'agent_chat') THEN
      RAISE EXCEPTION 'Service supplier reversal requires a verified actor type'
        USING ERRCODE = '42501';
    END IF;

    IF p_actor_type = 'user' THEN
      IF p_actor_id IS NULL OR NOT EXISTS (
        SELECT 1
        FROM public.company_members member
        WHERE member.company_id = p_company_id
          AND member.user_id = p_actor_id
      ) THEN
        RAISE EXCEPTION 'Service user actor is not a current company member'
          USING ERRCODE = '42501';
      END IF;
      v_actor_id := p_actor_id;
      v_actor_label := NULL;
    ELSE
      v_actor_label := NULLIF(btrim(p_actor_label), '');
      IF v_actor_label IS NULL THEN
        RAISE EXCEPTION 'Service non-user actor requires a verified label'
          USING ERRCODE = '42501';
      END IF;
      -- Non-user credential identities are labels, never auth.user UUIDs.
      v_actor_id := NULL;
    END IF;
    v_actor_type := p_actor_type;
  ELSE
    RAISE EXCEPTION 'Supplier reversal requires authenticated or service_role claims'
      USING ERRCODE = '42501';
  END IF;

  RETURN jsonb_build_object(
    'actor_type', v_actor_type,
    'actor_id', v_actor_id,
    'actor_label', v_actor_label
  );
END;
$function$;

REVOKE ALL ON FUNCTION public.resolve_supplier_reversal_actor(uuid, text, uuid, text)
  FROM PUBLIC, anon, authenticated, service_role;


-- Exact storno line verification used only by the trusted M3 command. EXCEPT
-- ALL preserves duplicate-line multiplicity.
CREATE OR REPLACE FUNCTION public.supplier_reversal_lines_match(
  p_original_id uuid,
  p_reversal_id uuid
)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path TO 'pg_catalog', 'public'
AS $function$
  SELECT
    EXISTS (
      SELECT 1 FROM public.journal_entry_lines line
      WHERE line.journal_entry_id = p_original_id
    )
    AND NOT EXISTS (
      WITH expected AS (
        SELECT
          line.account_number,
          line.account_id,
          round(COALESCE(line.credit_amount, 0) * 100) / 100 AS debit_amount,
          round(COALESCE(line.debit_amount, 0) * 100) / 100 AS credit_amount,
          line.currency,
          CASE WHEN line.amount_in_currency IS NULL THEN NULL ELSE -line.amount_in_currency END AS amount_in_currency,
          line.exchange_rate,
          line.sort_order,
          line.tax_code,
          line.dimensions
        FROM public.journal_entry_lines line
        WHERE line.journal_entry_id = p_original_id
      ),
      actual AS (
        SELECT
          line.account_number,
          line.account_id,
          line.debit_amount,
          line.credit_amount,
          line.currency,
          line.amount_in_currency,
          line.exchange_rate,
          line.sort_order,
          line.tax_code,
          line.dimensions
        FROM public.journal_entry_lines line
        WHERE line.journal_entry_id = p_reversal_id
      )
      SELECT 1 FROM (
        (SELECT * FROM expected EXCEPT ALL SELECT * FROM actual)
        UNION ALL
        (SELECT * FROM actual EXCEPT ALL SELECT * FROM expected)
      ) mismatch
    )
$function$;

REVOKE ALL ON FUNCTION public.supplier_reversal_lines_match(uuid, uuid)
  FROM PUBLIC, anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION public.supplier_accounting_lines_match(
  p_root_id uuid,
  p_correction_id uuid
)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path TO 'pg_catalog', 'public'
AS $function$
  SELECT
    EXISTS (
      SELECT 1 FROM public.journal_entry_lines line
      WHERE line.journal_entry_id = p_root_id
    )
    AND NOT EXISTS (
      WITH root_lines AS (
        SELECT
          line.account_number,
          line.account_id,
          line.debit_amount,
          line.credit_amount,
          line.currency,
          line.amount_in_currency,
          line.exchange_rate,
          line.sort_order,
          line.tax_code,
          line.dimensions
        FROM public.journal_entry_lines line
        WHERE line.journal_entry_id = p_root_id
      ),
      correction_lines AS (
        SELECT
          line.account_number,
          line.account_id,
          line.debit_amount,
          line.credit_amount,
          line.currency,
          line.amount_in_currency,
          line.exchange_rate,
          line.sort_order,
          line.tax_code,
          line.dimensions
        FROM public.journal_entry_lines line
        WHERE line.journal_entry_id = p_correction_id
      )
      SELECT 1 FROM (
        (SELECT * FROM root_lines EXCEPT ALL SELECT * FROM correction_lines)
        UNION ALL
        (SELECT * FROM correction_lines EXCEPT ALL SELECT * FROM root_lines)
      ) mismatch
    )
$function$;

REVOKE ALL ON FUNCTION public.supplier_accounting_lines_match(uuid, uuid)
  FROM PUBLIC, anon, authenticated, service_role;

-- Guard active allocation evidence. New rows require an exact supported
-- supplier-payment voucher and a verified allocation owner. Updates are
-- forbidden. Deletes require either an exact retained copy or exact sandbox
-- teardown capability minted by cleanup_sandbox_user.
CREATE OR REPLACE FUNCTION public.guard_supplier_payment_allocation()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'pg_catalog', 'public'
AS $function$
DECLARE
  v_claims jsonb := COALESCE(NULLIF(current_setting('request.jwt.claims', true), '')::jsonb, '{}'::jsonb);
  v_role text := COALESCE(v_claims ->> 'role', '');
  v_history_move boolean;
  v_sandbox_teardown boolean;
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.company_id IS NULL OR NEW.user_id IS NULL OR NEW.amount <= 0
       OR NEW.journal_entry_id IS NULL
       OR (
         v_role = 'authenticated'
         AND NEW.user_id IS DISTINCT FROM auth.uid()
       )
       OR (
         v_role = 'service_role'
         AND NOT EXISTS (
           SELECT 1
           FROM public.company_members member
           WHERE member.company_id = NEW.company_id
             AND member.user_id = NEW.user_id
         )
       )
       OR v_role NOT IN ('authenticated', 'service_role')
       OR NOT EXISTS (
         SELECT 1
         FROM public.supplier_invoices invoice
         WHERE invoice.id = NEW.supplier_invoice_id
           AND invoice.company_id = NEW.company_id
       )
       OR NOT EXISTS (
         SELECT 1
         FROM public.journal_entries entry
         WHERE entry.id = NEW.journal_entry_id
           AND entry.company_id = NEW.company_id
           AND entry.user_id = NEW.user_id
           AND entry.status = 'posted'
           AND (
             (
               entry.source_type IN (
                 'supplier_invoice_paid', 'supplier_invoice_cash_payment'
               )
               AND (
                 (
                   entry.source_type = 'supplier_invoice_cash_payment'
                   AND entry.source_id = NEW.supplier_invoice_id
                 )
                 OR (
                   entry.source_type = 'supplier_invoice_paid'
                   AND (
                     entry.source_id = NEW.supplier_invoice_id
                     OR (
                       entry.source_id IS NULL
                       AND NEW.transaction_id IS NOT NULL
                     )
                   )
                 )
               )
             )
             OR accounting_private.has_accounting_command_capability(
               'supplier_payment_allocation_create',
               NEW.company_id,
               NEW.id
             )
           )
       )
       OR (NEW.transaction_id IS NOT NULL AND NOT EXISTS (
         SELECT 1
         FROM public.transactions transaction_row
         WHERE transaction_row.id = NEW.transaction_id
           AND transaction_row.company_id = NEW.company_id
           AND transaction_row.user_id = NEW.user_id
       )) THEN
      RAISE EXCEPTION 'Invalid supplier payment allocation provenance'
        USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;

  IF TG_OP = 'UPDATE' THEN
    RAISE EXCEPTION 'Supplier payment allocations are immutable; reverse through apply_supplier_payment_reversal'
      USING ERRCODE = '23514';
  END IF;

  v_history_move := accounting_private.has_accounting_command_capability(
    'supplier_payment_allocation_history_move', OLD.company_id, OLD.id
  );
  v_sandbox_teardown := accounting_private.has_accounting_command_capability(
    'supplier_payment_allocation_teardown', OLD.company_id, OLD.id
  ) AND EXISTS (
    SELECT 1
    FROM public.company_settings settings
    WHERE settings.company_id = OLD.company_id
      AND settings.is_sandbox = true
  );

  IF v_history_move AND EXISTS (
    SELECT 1
    FROM public.supplier_invoice_payment_history history
    WHERE history.original_payment_id = OLD.id
      AND history.company_id IS NOT DISTINCT FROM OLD.company_id
      AND history.supplier_invoice_id IS NOT DISTINCT FROM OLD.supplier_invoice_id
      AND history.allocation_owner_user_id IS NOT DISTINCT FROM OLD.user_id
      AND history.payment_date IS NOT DISTINCT FROM OLD.payment_date
      AND history.amount IS NOT DISTINCT FROM OLD.amount
      AND history.currency IS NOT DISTINCT FROM OLD.currency
      AND history.exchange_rate IS NOT DISTINCT FROM OLD.exchange_rate
      AND history.exchange_rate_difference IS NOT DISTINCT FROM OLD.exchange_rate_difference
      AND history.payment_exchange_rate IS NOT DISTINCT FROM OLD.payment_exchange_rate
      AND history.journal_entry_id IS NOT DISTINCT FROM OLD.journal_entry_id
      AND history.transaction_id IS NOT DISTINCT FROM OLD.transaction_id
      AND history.notes IS NOT DISTINCT FROM OLD.notes
      AND history.allocation_created_at IS NOT DISTINCT FROM OLD.created_at
  ) THEN
    RETURN OLD;
  END IF;

  IF v_sandbox_teardown THEN
    RETURN OLD;
  END IF;

  RAISE EXCEPTION 'Supplier payment allocation deletion requires an exact command capability'
    USING ERRCODE = '23514';
END;
$function$;

DROP TRIGGER IF EXISTS guard_supplier_payment_allocation ON public.supplier_invoice_payments;
CREATE TRIGGER guard_supplier_payment_allocation
  BEFORE INSERT OR UPDATE OR DELETE ON public.supplier_invoice_payments
  FOR EACH ROW EXECUTE FUNCTION public.guard_supplier_payment_allocation();

REVOKE ALL ON FUNCTION public.guard_supplier_payment_allocation()
  FROM PUBLIC, anon, authenticated, service_role;

-- The voucher-link command is a supported producer of supplier allocations
-- even when the existing voucher has a manual or bank source type. It mints an
-- exact transaction-local capability for the preallocated payment row after
-- validating the caller, tenant, voucher, and amount.
CREATE OR REPLACE FUNCTION public.link_supplier_invoice_to_voucher(
  p_supplier_invoice_id uuid,
  p_journal_entry_id uuid,
  p_user_id uuid,
  p_company_id uuid,
  p_notes text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'pg_catalog', 'public'
AS $function$
DECLARE
  v_invoice record;
  v_voucher record;
  v_ap_debit_total numeric := 0;
  v_line_currency text;
  v_remaining numeric;
  v_payment_amount numeric;
  v_new_paid numeric;
  v_new_remaining numeric;
  v_new_status text;
  v_is_fully_paid boolean;
  v_now timestamptz := now();
  v_payment_id uuid := gen_random_uuid();
  v_jwt_role text := COALESCE(
    NULLIF(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role',
    ''
  );
  v_acting_user uuid;
  v_invoice_currency text;
  v_unreadable_count integer := 0;
  v_unreadable_currency text;
BEGIN
  IF v_jwt_role = 'authenticated' THEN
    v_acting_user := auth.uid();
    IF v_acting_user IS NULL
       OR NOT public.caller_is_company_member(p_company_id) THEN
      RETURN jsonb_build_object(
        'ok', false, 'code', 'LINK_SI_VOUCHER_INVOICE_NOT_FOUND'
      );
    END IF;
  ELSIF v_jwt_role = 'service_role' THEN
    v_acting_user := p_user_id;
    IF v_acting_user IS NULL OR NOT EXISTS (
      SELECT 1
      FROM public.company_members member
      WHERE member.company_id = p_company_id
        AND member.user_id = v_acting_user
    ) THEN
      RETURN jsonb_build_object(
        'ok', false, 'code', 'LINK_SI_VOUCHER_INVOICE_NOT_FOUND'
      );
    END IF;
  ELSE
    RAISE EXCEPTION 'Supplier voucher linking requires authenticated or service_role claims'
      USING ERRCODE = '42501';
  END IF;

  IF p_notes IS NOT NULL AND char_length(p_notes) > 2000 THEN
    RETURN jsonb_build_object(
      'ok', false,
      'code', 'LINK_SI_VOUCHER_NOTES_TOO_LONG',
      'details', jsonb_build_object(
        'max_length', 2000,
        'length', char_length(p_notes)
      )
    );
  END IF;

  SELECT * INTO v_invoice
  FROM public.supplier_invoices invoice
  WHERE invoice.id = p_supplier_invoice_id
    AND invoice.company_id = p_company_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object(
      'ok', false, 'code', 'LINK_SI_VOUCHER_INVOICE_NOT_FOUND'
    );
  END IF;

  IF v_invoice.status NOT IN (
    'registered', 'approved', 'overdue', 'partially_paid'
  ) THEN
    RETURN jsonb_build_object(
      'ok', false,
      'code', 'LINK_SI_VOUCHER_INVOICE_FULLY_PAID',
      'details', jsonb_build_object('status', v_invoice.status)
    );
  END IF;

  v_remaining := COALESCE(
    v_invoice.remaining_amount,
    v_invoice.total - COALESCE(v_invoice.paid_amount, 0)
  );
  IF v_remaining <= 0.005 THEN
    RETURN jsonb_build_object(
      'ok', false, 'code', 'LINK_SI_VOUCHER_INVOICE_FULLY_PAID'
    );
  END IF;

  SELECT * INTO v_voucher
  FROM public.journal_entries entry
  WHERE entry.id = p_journal_entry_id
    AND entry.company_id = p_company_id;

  IF NOT FOUND OR v_voucher.user_id IS DISTINCT FROM v_acting_user THEN
    RETURN jsonb_build_object(
      'ok', false, 'code', 'LINK_SI_VOUCHER_VOUCHER_NOT_FOUND'
    );
  END IF;

  IF v_voucher.status <> 'posted' THEN
    RETURN jsonb_build_object(
      'ok', false,
      'code', 'LINK_SI_VOUCHER_NOT_POSTED',
      'details', jsonb_build_object('status', v_voucher.status)
    );
  END IF;

  IF v_voucher.source_type IN ('opening_balance', 'storno') THEN
    RETURN jsonb_build_object(
      'ok', false,
      'code', 'LINK_SI_VOUCHER_NO_AP_DEBIT',
      'details', jsonb_build_object('source_type', v_voucher.source_type)
    );
  END IF;

  v_invoice_currency := COALESCE(v_invoice.currency, 'SEK');

  IF v_invoice_currency = 'SEK' THEN
    SELECT COALESCE(sum(line.debit_amount), 0), max(line.currency)
    INTO v_ap_debit_total, v_line_currency
    FROM public.journal_entry_lines line
    WHERE line.journal_entry_id = p_journal_entry_id
      AND line.account_number LIKE '244%'
      AND line.debit_amount > 0;
  ELSE
    SELECT
      COALESCE(sum(abs(line.amount_in_currency)) FILTER (
        WHERE line.currency = v_invoice_currency
          AND line.amount_in_currency IS NOT NULL
      ), 0),
      max(line.currency) FILTER (
        WHERE line.currency = v_invoice_currency
          AND line.amount_in_currency IS NOT NULL
      ),
      count(*) FILTER (
        WHERE line.currency IS DISTINCT FROM v_invoice_currency
          OR line.amount_in_currency IS NULL
      ),
      min(line.currency) FILTER (
        WHERE line.currency IS DISTINCT FROM v_invoice_currency
          OR line.amount_in_currency IS NULL
      )
    INTO
      v_ap_debit_total,
      v_line_currency,
      v_unreadable_count,
      v_unreadable_currency
    FROM public.journal_entry_lines line
    WHERE line.journal_entry_id = p_journal_entry_id
      AND line.account_number LIKE '244%'
      AND line.debit_amount > 0;

    IF COALESCE(v_unreadable_count, 0) > 0 THEN
      RETURN jsonb_build_object(
        'ok', false,
        'code', 'LINK_SI_VOUCHER_CURRENCY_MISMATCH',
        'details', jsonb_build_object(
          'invoice_currency', v_invoice.currency,
          'line_currency', v_unreadable_currency
        )
      );
    END IF;
  END IF;

  v_ap_debit_total := round(v_ap_debit_total * 100) / 100;

  IF v_ap_debit_total <= 0 THEN
    RETURN jsonb_build_object(
      'ok', false, 'code', 'LINK_SI_VOUCHER_NO_AP_DEBIT'
    );
  END IF;

  IF COALESCE(v_line_currency, v_invoice_currency)
       IS DISTINCT FROM v_invoice_currency THEN
    RETURN jsonb_build_object(
      'ok', false,
      'code', 'LINK_SI_VOUCHER_CURRENCY_MISMATCH',
      'details', jsonb_build_object(
        'invoice_currency', v_invoice.currency,
        'line_currency', v_line_currency
      )
    );
  END IF;

  IF v_ap_debit_total > v_remaining + 0.005 THEN
    RETURN jsonb_build_object(
      'ok', false,
      'code', 'LINK_SI_VOUCHER_AMOUNT_EXCEEDS_REMAINING',
      'details', jsonb_build_object(
        'ap_debit', v_ap_debit_total,
        'remaining', round(v_remaining * 100) / 100
      )
    );
  END IF;

  IF EXISTS (
    SELECT 1
    FROM public.supplier_invoice_payments payment
    WHERE payment.company_id = p_company_id
      AND payment.supplier_invoice_id = p_supplier_invoice_id
      AND payment.journal_entry_id = p_journal_entry_id
  ) THEN
    RETURN jsonb_build_object(
      'ok', false, 'code', 'LINK_SI_VOUCHER_ALREADY_LINKED'
    );
  END IF;

  v_payment_amount := LEAST(
    v_ap_debit_total,
    round(v_remaining * 100) / 100
  );
  v_new_remaining := GREATEST(
    0,
    round((v_remaining - v_payment_amount) * 100) / 100
  );
  v_new_paid := round(
    (COALESCE(v_invoice.paid_amount, 0) + v_payment_amount) * 100
  ) / 100;
  v_is_fully_paid := v_new_remaining <= 0.005;
  v_new_status := CASE
    WHEN v_is_fully_paid THEN 'paid'
    ELSE 'partially_paid'
  END;

  UPDATE public.supplier_invoices
  SET status = v_new_status,
      paid_at = CASE
        WHEN v_is_fully_paid THEN
          (
            (v_voucher.entry_date::timestamp + interval '12 hours')
            AT TIME ZONE 'UTC'
          )
        ELSE paid_at
      END,
      paid_amount = v_new_paid,
      remaining_amount = v_new_remaining,
      updated_at = v_now
  WHERE id = p_supplier_invoice_id;

  PERFORM accounting_private.grant_accounting_command_capability(
    'supplier_payment_allocation_create',
    p_company_id,
    v_payment_id
  );

  INSERT INTO public.supplier_invoice_payments (
    id, user_id, company_id, supplier_invoice_id, payment_date, amount,
    currency, journal_entry_id, transaction_id, notes
  ) VALUES (
    v_payment_id, v_acting_user, p_company_id, p_supplier_invoice_id,
    v_voucher.entry_date, v_payment_amount, v_invoice_currency,
    p_journal_entry_id, NULL, p_notes
  );

  PERFORM accounting_private.revoke_accounting_command_capability(
    'supplier_payment_allocation_create',
    p_company_id,
    v_payment_id
  );

  RETURN jsonb_build_object(
    'ok', true,
    'payment_id', v_payment_id,
    'invoice_status', v_new_status,
    'paid_amount', v_new_paid,
    'remaining_amount', v_new_remaining,
    'payment_amount', v_payment_amount,
    'journal_entry_id', p_journal_entry_id,
    'currency', v_invoice_currency
  );
END;
$function$;

REVOKE ALL ON FUNCTION public.link_supplier_invoice_to_voucher(
  uuid, uuid, uuid, uuid, text
) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.link_supplier_invoice_to_voucher(
  uuid, uuid, uuid, uuid, text
) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.guard_supplier_payment_history_mutation()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'pg_catalog', 'public'
AS $function$
BEGIN
  IF TG_OP = 'DELETE'
     AND accounting_private.has_accounting_command_capability(
       'supplier_payment_history_teardown', OLD.company_id, OLD.id
     )
     AND EXISTS (
       SELECT 1
       FROM public.company_settings settings
       WHERE settings.company_id = OLD.company_id
         AND settings.is_sandbox = true
     ) THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'Supplier payment history is immutable'
    USING ERRCODE = '23514';
END;
$function$;

CREATE TRIGGER guard_supplier_payment_history_mutation
  BEFORE UPDATE OR DELETE ON public.supplier_invoice_payment_history
  FOR EACH ROW EXECUTE FUNCTION public.guard_supplier_payment_history_mutation();

REVOKE ALL ON FUNCTION public.guard_supplier_payment_history_mutation()
  FROM PUBLIC, anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION public.guard_supplier_payment_parent_delete()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'pg_catalog', 'public'
AS $function$
DECLARE
  v_company_id uuid := OLD.company_id;
  v_action text := CASE
    WHEN TG_TABLE_NAME = 'supplier_invoices'
      THEN 'supplier_payment_invoice_teardown'
    ELSE 'supplier_payment_transaction_teardown'
  END;
BEGIN
  IF accounting_private.has_accounting_command_capability(v_action, v_company_id, OLD.id)
     AND EXISTS (
       SELECT 1
       FROM public.company_settings settings
       WHERE settings.company_id = v_company_id
         AND settings.is_sandbox = true
     ) THEN
    RETURN OLD;
  END IF;

  IF TG_TABLE_NAME = 'supplier_invoices' AND (
    EXISTS (
      SELECT 1 FROM public.supplier_invoice_payments payment
      WHERE payment.supplier_invoice_id = OLD.id
    ) OR EXISTS (
      SELECT 1 FROM public.supplier_invoice_payment_history history
      WHERE history.supplier_invoice_id = OLD.id
    )
  ) THEN
    RAISE EXCEPTION 'Cannot delete a supplier invoice with active or retained payment allocations'
      USING ERRCODE = '23514';
  ELSIF TG_TABLE_NAME = 'transactions' AND (
    EXISTS (
      SELECT 1 FROM public.supplier_invoice_payments payment
      WHERE payment.transaction_id = OLD.id
    ) OR EXISTS (
      SELECT 1 FROM public.supplier_invoice_payment_history history
      WHERE history.transaction_id = OLD.id
    )
  ) THEN
    RAISE EXCEPTION 'Cannot delete a transaction with active or retained supplier allocations'
      USING ERRCODE = '23514';
  END IF;

  RETURN OLD;
END;
$function$;

CREATE TRIGGER guard_supplier_invoice_payment_history_delete
  BEFORE DELETE ON public.supplier_invoices
  FOR EACH ROW EXECUTE FUNCTION public.guard_supplier_payment_parent_delete();
CREATE TRIGGER guard_transaction_supplier_payment_history_delete
  BEFORE DELETE ON public.transactions
  FOR EACH ROW EXECUTE FUNCTION public.guard_supplier_payment_parent_delete();

REVOKE ALL ON FUNCTION public.guard_supplier_payment_parent_delete()
  FROM PUBLIC, anon, authenticated, service_role;

-- Preserve the current sandbox cleanup command while adding exact M3 teardown
-- capabilities after its authoritative all-companies sandbox validation.
CREATE OR REPLACE FUNCTION public.cleanup_sandbox_user(p_user_id uuid)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'pg_catalog', 'public'
AS $function$
DECLARE
  v_deleted integer := 0;
  v_target record;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.company_settings settings
    WHERE settings.user_id = p_user_id
  ) OR EXISTS (
    SELECT 1 FROM public.company_settings settings
    WHERE settings.user_id = p_user_id
      AND settings.is_sandbox IS NOT TRUE
  ) THEN
    RAISE EXCEPTION 'User % is not a sandbox user', p_user_id;
  END IF;

  FOR v_target IN
    SELECT payment.company_id, payment.id
    FROM public.supplier_invoice_payments payment
    JOIN public.company_settings settings
      ON settings.company_id = payment.company_id
     AND settings.user_id = p_user_id
     AND settings.is_sandbox = true
    ORDER BY payment.company_id, payment.id
  LOOP
    PERFORM accounting_private.grant_accounting_command_capability(
      'supplier_payment_allocation_teardown',
      v_target.company_id,
      v_target.id
    );
  END LOOP;

  FOR v_target IN
    SELECT history.company_id, history.id
    FROM public.supplier_invoice_payment_history history
    JOIN public.company_settings settings
      ON settings.company_id = history.company_id
     AND settings.user_id = p_user_id
     AND settings.is_sandbox = true
    ORDER BY history.company_id, history.id
  LOOP
    PERFORM accounting_private.grant_accounting_command_capability(
      'supplier_payment_history_teardown',
      v_target.company_id,
      v_target.id
    );
  END LOOP;

  FOR v_target IN
    SELECT invoice.company_id, invoice.id
    FROM public.supplier_invoices invoice
    JOIN public.company_settings settings
      ON settings.company_id = invoice.company_id
     AND settings.user_id = p_user_id
     AND settings.is_sandbox = true
    WHERE EXISTS (
      SELECT 1
      FROM public.supplier_invoice_payments payment
      WHERE payment.supplier_invoice_id = invoice.id
    ) OR EXISTS (
      SELECT 1
      FROM public.supplier_invoice_payment_history history
      WHERE history.supplier_invoice_id = invoice.id
    )
    ORDER BY invoice.company_id, invoice.id
  LOOP
    PERFORM accounting_private.grant_accounting_command_capability(
      'supplier_payment_invoice_teardown',
      v_target.company_id,
      v_target.id
    );
  END LOOP;

  FOR v_target IN
    SELECT transaction_row.company_id, transaction_row.id
    FROM public.transactions transaction_row
    JOIN public.company_settings settings
      ON settings.company_id = transaction_row.company_id
     AND settings.user_id = p_user_id
     AND settings.is_sandbox = true
    WHERE EXISTS (
      SELECT 1
      FROM public.supplier_invoice_payments payment
      WHERE payment.transaction_id = transaction_row.id
    ) OR EXISTS (
      SELECT 1
      FROM public.supplier_invoice_payment_history history
      WHERE history.transaction_id = transaction_row.id
    )
    ORDER BY transaction_row.company_id, transaction_row.id
  LOOP
    PERFORM accounting_private.grant_accounting_command_capability(
      'supplier_payment_transaction_teardown',
      v_target.company_id,
      v_target.id
    );
  END LOOP;

  -- M6 delete guards use the same exact transaction-local capability
  -- substrate. Mint every protected salary-row identity only after the
  -- all-companies sandbox validation above.
  FOR v_target IN
    SELECT line.company_id, line.id
    FROM public.salary_line_items line
    JOIN public.salary_run_employees run_employee
      ON run_employee.id = line.salary_run_employee_id
     AND run_employee.company_id = line.company_id
    JOIN public.salary_runs run
      ON run.id = run_employee.salary_run_id
     AND run.company_id = run_employee.company_id
    JOIN public.company_settings settings
      ON settings.company_id = run.company_id
     AND settings.user_id = p_user_id
     AND settings.is_sandbox = true
    WHERE run.user_id = p_user_id
    ORDER BY line.company_id, line.id
  LOOP
    PERFORM accounting_private.grant_accounting_command_capability(
      'salary_mileage_line_delete',
      v_target.company_id,
      v_target.id
    );
  END LOOP;

  FOR v_target IN
    SELECT run_employee.company_id, run_employee.id
    FROM public.salary_run_employees run_employee
    JOIN public.salary_runs run
      ON run.id = run_employee.salary_run_id
     AND run.company_id = run_employee.company_id
    JOIN public.company_settings settings
      ON settings.company_id = run.company_id
     AND settings.user_id = p_user_id
     AND settings.is_sandbox = true
    WHERE run.user_id = p_user_id
    ORDER BY run_employee.company_id, run_employee.id
  LOOP
    PERFORM accounting_private.grant_accounting_command_capability(
      'salary_mileage_employee_delete',
      v_target.company_id,
      v_target.id
    );
  END LOOP;

  FOR v_target IN
    SELECT run.company_id, run.id
    FROM public.salary_runs run
    JOIN public.company_settings settings
      ON settings.company_id = run.company_id
     AND settings.user_id = p_user_id
     AND settings.is_sandbox = true
    WHERE run.user_id = p_user_id
    ORDER BY run.company_id, run.id
  LOOP
    PERFORM accounting_private.grant_accounting_command_capability(
      'salary_mileage_run_delete',
      v_target.company_id,
      v_target.id
    );
  END LOOP;

  PERFORM set_config('gnubok.allow_delete', 'true', true);
  PERFORM set_config('gnubok.sandbox_cleanup', 'true', true);

  DELETE FROM public.api_keys WHERE user_id = p_user_id;

  DELETE FROM public.dimension_retag_log
  WHERE company_id IN (
    SELECT settings.company_id
    FROM public.company_settings settings
    WHERE settings.user_id = p_user_id
      AND settings.is_sandbox = true
  );

  UPDATE public.document_attachments
  SET journal_entry_id = NULL, journal_entry_line_id = NULL
  WHERE user_id = p_user_id;

  DELETE FROM public.document_attachments WHERE user_id = p_user_id;

  UPDATE public.salary_runs
  SET salary_entry_id = NULL,
      avgifter_entry_id = NULL,
      pension_entry_id = NULL,
      vacation_entry_id = NULL
  WHERE user_id = p_user_id;

  DELETE FROM public.journal_entry_lines
  WHERE journal_entry_id IN (
    SELECT id FROM public.journal_entries WHERE user_id = p_user_id
  );

  DELETE FROM public.journal_entries WHERE user_id = p_user_id;
  DELETE FROM public.supplier_invoices WHERE user_id = p_user_id;
  DELETE FROM public.pending_operations WHERE user_id = p_user_id;

  DELETE FROM public.dimensions
  WHERE company_id IN (
    SELECT settings.company_id
    FROM public.company_settings settings
    WHERE settings.user_id = p_user_id
      AND settings.is_sandbox = true
  );

  DELETE FROM public.processing_history
  WHERE company_id IN (
    SELECT settings.company_id
    FROM public.company_settings settings
    WHERE settings.user_id = p_user_id
      AND settings.is_sandbox = true
  );

  DELETE FROM public.invoice_deliveries
  WHERE company_id IN (
    SELECT settings.company_id
    FROM public.company_settings settings
    WHERE settings.user_id = p_user_id
      AND settings.is_sandbox = true
  );

  DELETE FROM public.audit_log
  WHERE company_id IN (
    SELECT settings.company_id
    FROM public.company_settings settings
    WHERE settings.user_id = p_user_id
      AND settings.is_sandbox = true
  );

  DELETE FROM auth.users WHERE id = p_user_id;
  GET DIAGNOSTICS v_deleted = ROW_COUNT;

  PERFORM accounting_private.revoke_all_accounting_command_capabilities();
  PERFORM set_config('gnubok.allow_delete', '', true);
  PERFORM set_config('gnubok.sandbox_cleanup', '', true);

  RETURN v_deleted;
END;
$function$;

REVOKE ALL ON FUNCTION public.cleanup_sandbox_user(uuid)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.cleanup_sandbox_user(uuid)
  TO service_role;

-- One atomic supplier payment reversal. The function locks journal rows,
-- allocation rows, every transaction pointer, and every affected invoice in
-- stable UUID order before validating or changing business state.
CREATE OR REPLACE FUNCTION public.apply_supplier_payment_reversal(
  p_company_id uuid,
  p_root_journal_entry_id uuid,
  p_original_journal_entry_id uuid,
  p_reversal_date date,
  p_actor_type text,
  p_actor_id uuid,
  p_actor_label text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'pg_catalog', 'public'
AS $function$
DECLARE
  v_actor jsonb;
  v_publication_user_id uuid;
  v_actor_type text;
  v_actor_id uuid;
  v_actor_label text;
  v_lineage jsonb;
  v_locked_lineage jsonb;
  v_rows jsonb;
  v_root_id uuid;
  v_root_source_type text;
  v_live_id uuid;
  v_live_status text;
  v_live_reversed_by_id uuid;
  v_terminal_count integer;
  v_terminal_storno_count integer;
  v_terminal_storno_id uuid;
  v_graph_ids uuid[];
  v_row_count integer;
  v_distinct_row_count integer;
  v_root_row_count integer;
  v_locked_row_count integer;
  v_max_depth integer;
  v_max_correction_depth integer;
  v_terminal_storno_depth integer;
  v_bad_row boolean;
  v_is_supplier boolean;
  v_allocation_owner_id uuid;
  v_allocation_owner_count integer;
  v_allocation_user_id uuid;
  v_allocation_user_count integer;
  v_root public.journal_entries%ROWTYPE;
  v_live public.journal_entries%ROWTYPE;
  v_reversal public.journal_entries%ROWTYPE;
  v_command public.supplier_payment_reversals%ROWTYPE;
  v_command_id uuid;
  v_reversal_id uuid;
  v_voucher_number integer;
  v_active_count integer;
  v_history_count integer;
  v_existing_storno_count integer;
  v_reversal_period public.fiscal_periods%ROWTYPE;
  v_reversal_period_count integer;
  v_company_lock_date date;
  v_now timestamptz := clock_timestamp();
  v_committed_key text;
  v_reversed_key text;
  v_committed_payload jsonb;
  v_reversed_payload jsonb;
  v_committed_publication jsonb;
  v_reversed_publication jsonb;
  v_invoice record;
  v_compat_invoice public.supplier_invoices%ROWTYPE;
  v_compat_amount numeric;
  v_has_compatibility boolean := false;
BEGIN
  IF p_company_id IS NULL OR p_root_journal_entry_id IS NULL
     OR p_original_journal_entry_id IS NULL OR p_reversal_date IS NULL THEN
    RAISE EXCEPTION 'Supplier reversal company, root, original, and date are required'
      USING ERRCODE = '22004';
  END IF;

  v_actor := public.resolve_supplier_reversal_actor(
    p_company_id, p_actor_type, p_actor_id, p_actor_label
  );
  v_actor_type := v_actor ->> 'actor_type';
  v_actor_id := NULLIF(v_actor ->> 'actor_id', '')::uuid;
  v_actor_label := NULLIF(v_actor ->> 'actor_label', '');

  v_lineage := public.get_journal_lineage(
    p_company_id, ARRAY[p_root_journal_entry_id]
  );
  IF jsonb_typeof(v_lineage) IS DISTINCT FROM 'object'
     OR NOT v_lineage ?& ARRAY[
       'valid', 'company_id', 'requested_root_count', 'row_count',
       'max_depth', 'max_correction_depth', 'terminal_storno_depth', 'rows'
     ]
     OR (SELECT count(*) FROM jsonb_object_keys(v_lineage)) <> 8
     OR v_lineage -> 'valid' IS DISTINCT FROM 'true'::jsonb
     OR v_lineage -> 'company_id' IS DISTINCT FROM to_jsonb(p_company_id)
     OR v_lineage -> 'requested_root_count' IS DISTINCT FROM '1'::jsonb
     OR jsonb_typeof(v_lineage -> 'row_count') IS DISTINCT FROM 'number'
     OR jsonb_typeof(v_lineage -> 'max_depth') IS DISTINCT FROM 'number'
     OR jsonb_typeof(v_lineage -> 'max_correction_depth') IS DISTINCT FROM 'number'
     OR (
       v_lineage -> 'terminal_storno_depth' <> 'null'::jsonb
       AND jsonb_typeof(v_lineage -> 'terminal_storno_depth') IS DISTINCT FROM 'number'
     )
     OR jsonb_typeof(v_lineage -> 'rows') IS DISTINCT FROM 'array' THEN
    RAISE EXCEPTION 'M2 journal lineage returned an incomplete supplier envelope'
      USING ERRCODE = '23514';
  END IF;
  v_rows := v_lineage -> 'rows';

  IF EXISTS (
    SELECT 1
    FROM jsonb_array_elements(v_rows) node
    WHERE jsonb_typeof(node) IS DISTINCT FROM 'object'
  ) THEN
    RAISE EXCEPTION 'M2 journal lineage returned a non-object row'
      USING ERRCODE = '23514';
  END IF;
  IF EXISTS (
    SELECT 1
    FROM jsonb_array_elements(v_rows) node
    WHERE NOT node ?& ARRAY[
      'root_id', 'parent_id', 'edge_kind', 'id', 'company_id', 'entry_date',
      'status', 'source_type', 'correction_of_id', 'reverses_id',
      'reversed_by_id', 'committed_at', 'depth', 'path', 'cycle'
    ]
       OR (SELECT count(*) FROM jsonb_object_keys(node)) <> 15
  ) THEN
    RAISE EXCEPTION 'M2 journal lineage returned an incomplete row identity'
      USING ERRCODE = '23514';
  END IF;

  WITH nodes AS MATERIALIZED (
    SELECT *
    FROM jsonb_to_recordset(v_rows) AS node(
      root_id uuid,
      parent_id uuid,
      edge_kind text,
      id uuid,
      company_id uuid,
      entry_date date,
      status text,
      source_type text,
      correction_of_id uuid,
      reverses_id uuid,
      reversed_by_id uuid,
      committed_at timestamptz,
      depth integer,
      path uuid[],
      cycle boolean
    )
  ),
  annotated AS (
    SELECT
      node.*,
      node.edge_kind IN ('root', 'correction')
        AND NOT EXISTS (
          SELECT 1
          FROM nodes child
          WHERE child.edge_kind = 'correction'
            AND child.parent_id = node.id
        ) AS is_terminal_correction
    FROM nodes node
  )
  SELECT
    count(*)::integer,
    count(DISTINCT id)::integer,
    count(*) FILTER (WHERE edge_kind = 'root')::integer,
    (array_agg(id ORDER BY id) FILTER (WHERE edge_kind = 'root'))[1],
    (array_agg(source_type ORDER BY id) FILTER (WHERE edge_kind = 'root'))[1],
    COALESCE(max(depth), 0)::integer,
    COALESCE(max(depth) FILTER (WHERE edge_kind IN ('root', 'correction')), 0)::integer,
    max(depth) FILTER (WHERE edge_kind = 'storno')::integer,
    COALESCE(bool_or(
      root_id IS DISTINCT FROM p_root_journal_entry_id
      OR company_id IS DISTINCT FROM p_company_id
      OR edge_kind IS NULL
      OR status IS NULL
      OR committed_at IS NULL
      OR source_type IS NULL
      OR id IS NULL
      OR depth IS NULL
      OR depth < 0
      OR path IS NULL
      OR cardinality(path) IS DISTINCT FROM depth + 1
      OR path[1] IS DISTINCT FROM root_id
      OR path[cardinality(path)] IS DISTINCT FROM id
      OR cycle IS DISTINCT FROM false
      OR edge_kind NOT IN ('root', 'correction', 'storno')
      OR (edge_kind = 'root' AND (
        id IS DISTINCT FROM root_id
        OR parent_id IS NOT NULL
        OR depth <> 0
      ))
      OR (edge_kind = 'correction' AND (
        source_type IS DISTINCT FROM 'correction'
        OR correction_of_id IS DISTINCT FROM parent_id
        OR reverses_id IS NOT NULL
      ))
      OR (edge_kind = 'storno' AND (
        source_type IS DISTINCT FROM 'storno'
        OR reverses_id IS DISTINCT FROM parent_id
        OR correction_of_id IS NOT NULL
        OR reversed_by_id IS NOT NULL
        OR status IS DISTINCT FROM 'posted'
      ))
      OR (edge_kind <> 'root' AND NOT EXISTS (
        SELECT 1
        FROM nodes parent
        WHERE parent.id = annotated.parent_id
      ))
    ), false),
    array_agg(id ORDER BY id),
    count(*) FILTER (WHERE is_terminal_correction)::integer,
    (array_agg(id ORDER BY id) FILTER (WHERE is_terminal_correction))[1],
    (array_agg(status ORDER BY id) FILTER (WHERE is_terminal_correction))[1],
    (array_agg(reversed_by_id ORDER BY id) FILTER (WHERE is_terminal_correction))[1]
  INTO
    v_row_count,
    v_distinct_row_count,
    v_root_row_count,
    v_root_id,
    v_root_source_type,
    v_max_depth,
    v_max_correction_depth,
    v_terminal_storno_depth,
    v_bad_row,
    v_graph_ids,
    v_terminal_count,
    v_live_id,
    v_live_status,
    v_live_reversed_by_id
  FROM annotated;

  IF v_row_count = 0
     OR v_row_count IS DISTINCT FROM v_distinct_row_count
     OR v_row_count IS DISTINCT FROM jsonb_array_length(v_rows)
     OR v_root_row_count IS DISTINCT FROM 1
     OR v_root_id IS DISTINCT FROM p_root_journal_entry_id
     OR v_bad_row
     OR v_lineage -> 'row_count' IS DISTINCT FROM to_jsonb(v_row_count)
     OR v_lineage -> 'max_depth' IS DISTINCT FROM to_jsonb(v_max_depth)
     OR v_lineage -> 'max_correction_depth' IS DISTINCT FROM to_jsonb(v_max_correction_depth)
     OR v_lineage -> 'terminal_storno_depth' IS DISTINCT FROM
        COALESCE(to_jsonb(v_terminal_storno_depth), 'null'::jsonb) THEN
    RAISE EXCEPTION 'M2 journal lineage envelope contradicts its exact row identities'
      USING ERRCODE = '23514';
  END IF;

  IF v_terminal_count IS DISTINCT FROM 1
     OR v_live_id IS DISTINCT FROM p_original_journal_entry_id THEN
    RAISE EXCEPTION 'Requested original is not the unique terminal correction node'
      USING ERRCODE = '22023';
  END IF;

  WITH nodes AS (
    SELECT *
    FROM jsonb_to_recordset(v_rows) AS node(
      parent_id uuid,
      edge_kind text,
      id uuid,
      status text,
      source_type text,
      reverses_id uuid
    )
  )
  SELECT
    count(*)::integer,
    (array_agg(id ORDER BY id))[1]
  INTO v_terminal_storno_count, v_terminal_storno_id
  FROM nodes
  WHERE edge_kind = 'storno'
    AND parent_id = v_live_id
    AND source_type = 'storno'
    AND status = 'posted'
    AND reverses_id = v_live_id;

  IF v_live_status IS NULL
     OR (v_live_status = 'posted' AND (
       v_live_reversed_by_id IS NOT NULL
       OR v_terminal_storno_count <> 0
     ))
     OR (v_live_status = 'reversed' AND (
       v_live_reversed_by_id IS NULL
       OR v_terminal_storno_count <> 1
       OR v_terminal_storno_id IS DISTINCT FROM v_live_reversed_by_id
     ))
     OR v_live_status NOT IN ('posted', 'reversed') THEN
    RAISE EXCEPTION 'Requested original is not posted or exactly reversed by its terminal storno'
      USING ERRCODE = '23514';
  END IF;

  v_is_supplier := v_root_source_type IN (
    'supplier_invoice_paid', 'supplier_invoice_cash_payment'
  ) OR EXISTS (
    SELECT 1
    FROM public.supplier_invoice_payments payment
    WHERE payment.company_id = p_company_id
      AND payment.journal_entry_id = v_root_id
  ) OR EXISTS (
    SELECT 1
    FROM public.supplier_invoice_payment_history history
    WHERE history.company_id = p_company_id
      AND history.lineage_root_journal_entry_id = v_root_id
  );
  IF COALESCE(v_is_supplier, false) IS NOT TRUE THEN
    RAISE EXCEPTION 'Requested journal entry is not a supplier payment lineage'
      USING ERRCODE = '22023';
  END IF;

  PERFORM entry.id
  FROM public.journal_entries entry
  WHERE entry.company_id = p_company_id
    AND entry.id = ANY(v_graph_ids)
  ORDER BY entry.id
  FOR UPDATE;
  GET DIAGNOSTICS v_locked_row_count = ROW_COUNT;
  IF v_locked_row_count IS DISTINCT FROM v_row_count THEN
    RAISE EXCEPTION 'Supplier payment graph changed while locking'
      USING ERRCODE = '40001';
  END IF;

  v_locked_lineage := public.get_journal_lineage(
    p_company_id, ARRAY[p_root_journal_entry_id]
  );
  IF convert_to(v_locked_lineage::text, 'UTF8')
       IS DISTINCT FROM convert_to(v_lineage::text, 'UTF8') THEN
    RAISE EXCEPTION 'Supplier payment lineage changed while locking'
      USING ERRCODE = '40001';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM jsonb_array_elements(v_rows) node
    WHERE node ->> 'edge_kind' = 'correction'
      AND NOT public.supplier_accounting_lines_match(
        v_root_id,
        (node ->> 'id')::uuid
      )
  ) THEN
    RAISE EXCEPTION 'Supplier correction changes the root accounting-line multiset'
      USING ERRCODE = '23514';
  END IF;

  SELECT * INTO v_root
  FROM public.journal_entries entry
  WHERE entry.id = v_root_id
    AND entry.company_id = p_company_id;
  SELECT * INTO v_live
  FROM public.journal_entries entry
  WHERE entry.id = v_live_id
    AND entry.company_id = p_company_id;

  SELECT
    count(DISTINCT owner.user_id)::integer,
    (array_agg(DISTINCT owner.user_id ORDER BY owner.user_id))[1]
  INTO v_allocation_user_count, v_allocation_user_id
  FROM (
    SELECT payment.user_id
    FROM public.supplier_invoice_payments payment
    WHERE payment.company_id = p_company_id
      AND payment.journal_entry_id = ANY(v_graph_ids)
    UNION ALL
    SELECT history.allocation_owner_user_id
    FROM public.supplier_invoice_payment_history history
    WHERE history.company_id = p_company_id
      AND history.lineage_root_journal_entry_id = v_root_id
  ) owner;

  IF v_allocation_user_count > 1 THEN
    RAISE EXCEPTION 'Supplier allocation owners are contradictory'
      USING ERRCODE = '23514';
  END IF;

  v_publication_user_id := COALESCE(v_allocation_user_id, v_root.user_id);
  IF v_publication_user_id IS NULL OR NOT EXISTS (
    SELECT 1
    FROM public.company_members member
    WHERE member.company_id = p_company_id
      AND member.user_id = v_publication_user_id
  ) THEN
    RAISE EXCEPTION 'Supplier reversal publication principal is not a current company member'
      USING ERRCODE = '42501';
  END IF;
  SELECT count(*)::integer
  INTO v_reversal_period_count
  FROM public.fiscal_periods period
  WHERE period.company_id = p_company_id
    AND p_reversal_date BETWEEN period.period_start AND period.period_end;

  IF v_reversal_period_count IS DISTINCT FROM 1 THEN
    RAISE EXCEPTION 'Reversal date must resolve to exactly one company fiscal period'
      USING ERRCODE = '22007';
  END IF;

  SELECT period.*
  INTO v_reversal_period
  FROM public.fiscal_periods period
  WHERE period.company_id = p_company_id
    AND p_reversal_date BETWEEN period.period_start AND period.period_end
  FOR UPDATE;


  SELECT * INTO v_command
  FROM public.supplier_payment_reversals command
  WHERE command.company_id = p_company_id
    AND command.root_journal_entry_id = v_root_id
  FOR UPDATE;

  IF FOUND THEN
    v_allocation_owner_id := v_command.allocation_owner_journal_entry_id;
    IF v_command.requested_journal_entry_id IS DISTINCT FROM p_original_journal_entry_id
       OR v_command.live_journal_entry_id IS DISTINCT FROM v_live_id
       OR v_command.reversal_date IS DISTINCT FROM p_reversal_date
       OR v_command.reversal_fiscal_period_id IS DISTINCT FROM v_reversal_period.id
       OR v_command.publication_user_id IS DISTINCT FROM v_publication_user_id
       OR v_command.actor_type IS DISTINCT FROM v_actor_type
       OR v_command.actor_id IS DISTINCT FROM v_actor_id
       OR v_command.actor_label IS DISTINCT FROM v_actor_label
       OR v_live.status IS DISTINCT FROM 'reversed'
       OR v_live.reversed_by_id IS DISTINCT FROM v_command.reversal_journal_entry_id THEN
      RETURN jsonb_build_object(
        'status', 'conflict',
        'reason', 'stored supplier reversal identity differs',
        'company_id', p_company_id,
        'root_journal_entry_id', v_root_id,
        'original_journal_entry_id', p_original_journal_entry_id,
        'reversal_journal_entry_id', v_command.reversal_journal_entry_id
      );
    END IF;

    SELECT * INTO v_reversal
    FROM public.journal_entries entry
    WHERE entry.id = v_command.reversal_journal_entry_id
      AND entry.company_id = p_company_id
    FOR UPDATE;

    IF NOT FOUND OR v_reversal.status IS DISTINCT FROM 'posted'
       OR v_reversal.source_type IS DISTINCT FROM 'storno'
       OR v_reversal.reverses_id IS DISTINCT FROM v_live_id
       OR v_reversal.entry_date IS DISTINCT FROM p_reversal_date
       OR v_reversal.fiscal_period_id IS DISTINCT FROM v_reversal_period.id
       OR NOT public.supplier_reversal_lines_match(v_live_id, v_reversal.id) THEN
      RAISE EXCEPTION 'Stored supplier reversal storno is missing or contradictory'
        USING ERRCODE = '23514';
    END IF;

    SELECT count(*)::integer
    INTO v_history_count
    FROM public.supplier_invoice_payment_history history
    WHERE history.reversal_command_id = v_command.id;

    IF v_history_count IS DISTINCT FROM v_command.allocation_count
       OR EXISTS (
         SELECT 1
         FROM public.supplier_invoice_payments payment
         WHERE payment.company_id = p_company_id
           AND payment.journal_entry_id = ANY(v_graph_ids)
       )
       OR EXISTS (
         SELECT 1
         FROM public.supplier_invoice_payment_history history
         WHERE history.reversal_command_id = v_command.id
           AND history.journal_entry_id IS DISTINCT FROM v_allocation_owner_id
       )
       OR EXISTS (
         SELECT 1
         FROM public.supplier_invoice_payment_history history
         JOIN public.transactions transaction_row
           ON transaction_row.id = history.transaction_id
          AND transaction_row.company_id = history.company_id
         WHERE history.reversal_command_id = v_command.id
           AND transaction_row.journal_entry_id = v_allocation_owner_id
       )
       OR EXISTS (
         SELECT 1
         FROM (
           SELECT DISTINCT history.supplier_invoice_id
           FROM public.supplier_invoice_payment_history history
           WHERE history.reversal_command_id = v_command.id
         ) affected
         JOIN public.supplier_invoices invoice
           ON invoice.id = affected.supplier_invoice_id
          AND invoice.company_id = p_company_id
         CROSS JOIN LATERAL (
           SELECT round(COALESCE(sum(active.amount), 0) * 100) / 100 AS active_paid
           FROM public.supplier_invoice_payments active
           WHERE active.company_id = p_company_id
             AND active.supplier_invoice_id = affected.supplier_invoice_id
         ) totals
         WHERE round(COALESCE(invoice.paid_amount, 0) * 100) / 100
                 IS DISTINCT FROM totals.active_paid
            OR round(COALESCE(invoice.remaining_amount, invoice.total) * 100) / 100
                 IS DISTINCT FROM GREATEST(
                   0, round((invoice.total - totals.active_paid) * 100) / 100
                 )
            OR invoice.status IS DISTINCT FROM CASE
                 WHEN totals.active_paid >= round(invoice.total * 100) / 100 - 0.005 THEN 'paid'
                 WHEN totals.active_paid > 0 THEN 'partially_paid'
                 ELSE 'registered'
               END
       ) THEN
      RAISE EXCEPTION 'Stored supplier reversal allocation or transaction state is incomplete'
        USING ERRCODE = '55000';
    END IF;

    v_committed_key := 'journal:' || v_reversal.id::text || ':committed';
    v_reversed_key := 'journal:' || v_live_id::text || ':reversed';
    v_committed_payload := jsonb_build_object(
      'companyId', p_company_id,
      'userId', v_command.publication_user_id,
      'entry', public.accounting_journal_entry_event_object(
        p_company_id, v_reversal.id
      )
    );
    v_reversed_payload := jsonb_build_object(
      'companyId', p_company_id,
      'userId', v_command.publication_user_id,
      'originalEntry', public.accounting_journal_entry_event_object(
        p_company_id, v_live_id
      ),
      'reversalEntry', public.accounting_journal_entry_event_object(
        p_company_id, v_reversal.id
      )
    );
    v_committed_publication := public.record_accounting_publication(
      p_company_id, v_committed_key, 'journal_entry.committed', v_reversal.id,
      v_command.publication_user_id, v_committed_payload
    );
    v_reversed_publication := public.record_accounting_publication(
      p_company_id, v_reversed_key, 'journal_entry.reversed', v_reversal.id,
      v_command.publication_user_id, v_reversed_payload
    );

    IF (v_committed_publication ->> 'publication_id')::uuid IS DISTINCT FROM v_command.committed_publication_id
       OR (v_reversed_publication ->> 'publication_id')::uuid IS DISTINCT FROM v_command.reversed_publication_id THEN
      RAISE EXCEPTION 'Stored supplier reversal publication identity is contradictory'
        USING ERRCODE = '55000';
    END IF;

    RETURN jsonb_build_object(
      'status', 'already_applied',
      'company_id', p_company_id,
      'root_journal_entry_id', v_root_id,
      'original_journal_entry_id', p_original_journal_entry_id,
      'reversal_journal_entry_id', v_reversal.id,
      'actor_type', v_command.actor_type,
      'actor_id', v_command.actor_id,
      'actor_label', v_command.actor_label,
      'publications', jsonb_build_array(
        jsonb_build_object(
          'publication_id', v_command.committed_publication_id,
          'event_key', v_committed_key,
          'event_type', 'journal_entry.committed'
        ),
        jsonb_build_object(
          'publication_id', v_command.reversed_publication_id,
          'event_key', v_reversed_key,
          'event_type', 'journal_entry.reversed'
        )
      )
    );
  END IF;
  IF v_reversal_period.is_closed
     OR v_reversal_period.locked_at IS NOT NULL THEN
    RAISE EXCEPTION 'Cannot reverse supplier payment in a locked or closed fiscal period'
      USING ERRCODE = '23514';
  END IF;

  SELECT settings.bookkeeping_locked_through
  INTO v_company_lock_date
  FROM public.company_settings settings
  WHERE settings.company_id = p_company_id
  FOR SHARE;

  IF v_company_lock_date IS NOT NULL
     AND p_reversal_date <= v_company_lock_date THEN
    RAISE EXCEPTION 'Bookkeeping is locked through %', v_company_lock_date
      USING ERRCODE = '23514';
  END IF;

  SELECT
    count(DISTINCT payment.journal_entry_id)::integer,
    (array_agg(DISTINCT payment.journal_entry_id ORDER BY payment.journal_entry_id))[1]
  INTO v_allocation_owner_count, v_allocation_owner_id
  FROM public.supplier_invoice_payments payment
  WHERE payment.company_id = p_company_id
    AND payment.journal_entry_id = ANY(v_graph_ids);

  IF v_allocation_owner_count > 1
     OR (
       v_allocation_owner_id IS NOT NULL
       AND v_allocation_owner_id NOT IN (v_root_id, v_live_id)
     ) THEN
    RAISE EXCEPTION 'Supplier allocations do not have one permitted lineage owner'
      USING ERRCODE = '23514';
  END IF;
  v_allocation_owner_id := COALESCE(v_allocation_owner_id, v_root_id);

  PERFORM payment.id
  FROM public.supplier_invoice_payments payment
  WHERE payment.company_id = p_company_id
    AND payment.journal_entry_id = v_allocation_owner_id
  ORDER BY payment.id
  FOR UPDATE;

  SELECT count(*)::integer INTO v_active_count
  FROM public.supplier_invoice_payments payment
  WHERE payment.company_id = p_company_id
    AND payment.journal_entry_id = v_allocation_owner_id;

  SELECT count(*)::integer INTO v_history_count
  FROM public.supplier_invoice_payment_history history
  WHERE history.company_id = p_company_id
    AND history.lineage_root_journal_entry_id = v_root_id;

  IF v_history_count <> 0 THEN
    RAISE EXCEPTION 'Supplier payment history exists without its durable reversal command'
      USING ERRCODE = '23514';
  END IF;

  -- Lock transaction pointers before invoices to match the allocation RPC lock
  -- order and prevent a rematch between validation and pointer clearing.
  PERFORM transaction_row.id
  FROM public.transactions transaction_row
  WHERE transaction_row.company_id = p_company_id
    AND transaction_row.id IN (
      SELECT payment.transaction_id
      FROM public.supplier_invoice_payments payment
      WHERE payment.company_id = p_company_id
        AND payment.journal_entry_id = v_allocation_owner_id
        AND payment.transaction_id IS NOT NULL
    )
  ORDER BY transaction_row.id
  FOR UPDATE;

  PERFORM invoice.id
  FROM public.supplier_invoices invoice
  WHERE invoice.company_id = p_company_id
    AND invoice.id IN (
      SELECT payment.supplier_invoice_id
      FROM public.supplier_invoice_payments payment
      WHERE payment.company_id = p_company_id
        AND payment.journal_entry_id = v_allocation_owner_id
    )
  ORDER BY invoice.id
  FOR UPDATE;

  IF EXISTS (
    SELECT 1
    FROM public.supplier_invoice_payments payment
    LEFT JOIN public.supplier_invoices invoice
      ON invoice.id = payment.supplier_invoice_id
     AND invoice.company_id = payment.company_id
    LEFT JOIN public.journal_entries allocation_entry
      ON allocation_entry.id = payment.journal_entry_id
     AND allocation_entry.company_id = payment.company_id
    LEFT JOIN public.transactions transaction_row
      ON transaction_row.id = payment.transaction_id
     AND transaction_row.company_id = payment.company_id
    WHERE payment.company_id = p_company_id
      AND payment.journal_entry_id = v_allocation_owner_id
      AND (
        payment.amount <= 0
        OR invoice.id IS NULL
        OR allocation_entry.id IS NULL
        OR allocation_entry.status NOT IN ('posted', 'reversed')
        OR allocation_entry.user_id IS DISTINCT FROM payment.user_id
        OR allocation_entry.source_type IN ('opening_balance', 'storno')
        OR (
          allocation_entry.source_type = 'supplier_invoice_cash_payment'
          AND allocation_entry.source_id IS DISTINCT FROM payment.supplier_invoice_id
        )
        OR (
          allocation_entry.source_type = 'supplier_invoice_paid'
          AND allocation_entry.source_id IS DISTINCT FROM payment.supplier_invoice_id
          AND NOT (
            allocation_entry.source_id IS NULL
            AND payment.transaction_id IS NOT NULL
          )
        )
        OR (payment.transaction_id IS NOT NULL AND (
          transaction_row.id IS NULL
          OR transaction_row.user_id IS DISTINCT FROM payment.user_id
          OR transaction_row.journal_entry_id IS DISTINCT FROM v_allocation_owner_id
        ))
      )
  ) THEN
    RAISE EXCEPTION 'Supplier allocation provenance or transaction pointer drifted'
      USING ERRCODE = '23514';
  END IF;

  IF v_active_count = 0 THEN
    -- Bounded allocation-free recovery for the exact full-payment shapes named
    -- by the consolidated boundary. Manual vouchers are never inferred.
    IF v_root_id IS DISTINCT FROM v_live_id
       OR v_root.source_type NOT IN ('supplier_invoice_paid', 'supplier_invoice_cash_payment')
       OR v_root.source_id IS NULL THEN
      RAISE EXCEPTION 'Supplier payment lineage has no active allocation evidence'
        USING ERRCODE = '23514';
    END IF;

    SELECT * INTO v_compat_invoice
    FROM public.supplier_invoices invoice
    WHERE invoice.id = v_root.source_id
      AND invoice.company_id = p_company_id
    FOR UPDATE;

    IF NOT FOUND OR v_compat_invoice.payment_journal_entry_id IS DISTINCT FROM v_root_id
       OR v_compat_invoice.status IS DISTINCT FROM 'paid'
       OR round(COALESCE(v_compat_invoice.paid_amount, 0) * 100) / 100
          IS DISTINCT FROM round(v_compat_invoice.total * 100) / 100
       OR round(COALESCE(v_compat_invoice.remaining_amount, 0) * 100) / 100 <> 0 THEN
      RAISE EXCEPTION 'Allocation-free supplier payment does not have an exact full-payment before-state'
        USING ERRCODE = '23514';
    END IF;

    SELECT round(COALESCE(sum(
      CASE
        WHEN COALESCE(v_compat_invoice.currency, 'SEK') = 'SEK' THEN line.debit_amount
        WHEN line.currency = v_compat_invoice.currency THEN abs(line.amount_in_currency)
        ELSE NULL
      END
    ), 0) * 100) / 100
    INTO v_compat_amount
    FROM public.journal_entry_lines line
    WHERE line.journal_entry_id = v_root_id
      AND line.account_number LIKE '244%'
      AND line.debit_amount > 0;

    IF v_compat_amount IS DISTINCT FROM round(v_compat_invoice.total * 100) / 100 THEN
      RAISE EXCEPTION 'Allocation-free supplier payment AP debit does not match the invoice total'
        USING ERRCODE = '23514';
    END IF;
    v_has_compatibility := true;

    IF v_compat_invoice.transaction_id IS NOT NULL THEN
      PERFORM transaction_row.id
      FROM public.transactions transaction_row
      WHERE transaction_row.id = v_compat_invoice.transaction_id
        AND transaction_row.company_id = p_company_id
      FOR UPDATE;
      IF NOT FOUND OR EXISTS (
        SELECT 1
        FROM public.transactions transaction_row
        WHERE transaction_row.id = v_compat_invoice.transaction_id
          AND transaction_row.company_id = p_company_id
          AND transaction_row.journal_entry_id IS DISTINCT FROM v_root_id
      ) THEN
        RAISE EXCEPTION 'Allocation-free supplier transaction pointer drifted'
          USING ERRCODE = '23514';
      END IF;
    END IF;
  ELSE
    IF EXISTS (
      SELECT 1
      FROM public.supplier_invoices invoice
      JOIN (
        SELECT payment.supplier_invoice_id, round(sum(payment.amount) * 100) / 100 AS active_paid
        FROM public.supplier_invoice_payments payment
        WHERE payment.company_id = p_company_id
        GROUP BY payment.supplier_invoice_id
      ) totals ON totals.supplier_invoice_id = invoice.id
      WHERE invoice.company_id = p_company_id
        AND invoice.id IN (
          SELECT payment.supplier_invoice_id
          FROM public.supplier_invoice_payments payment
          WHERE payment.company_id = p_company_id
            AND payment.journal_entry_id = v_allocation_owner_id
        )
        AND (
          round(COALESCE(invoice.paid_amount, 0) * 100) / 100 IS DISTINCT FROM totals.active_paid
          OR round(COALESCE(invoice.remaining_amount, invoice.total) * 100) / 100
             IS DISTINCT FROM round((invoice.total - totals.active_paid) * 100) / 100
        )
    ) THEN
      RAISE EXCEPTION 'Supplier invoice denormalized totals contradict active allocations'
        USING ERRCODE = '23514';
    END IF;
  END IF;

  SELECT count(*)::integer
  INTO v_existing_storno_count
  FROM public.journal_entries entry
  WHERE entry.company_id = p_company_id
    AND entry.reverses_id = v_live_id
    AND entry.source_type = 'storno'
    AND entry.status IN ('posted', 'reversed');

  IF v_live.status = 'reversed' THEN
    IF v_existing_storno_count <> 1 OR v_live.reversed_by_id IS NULL THEN
      RETURN jsonb_build_object(
        'status', 'conflict',
        'reason', 'reversed live node lacks one exact recorded storno',
        'company_id', p_company_id,
        'root_journal_entry_id', v_root_id,
        'original_journal_entry_id', p_original_journal_entry_id,
        'reversal_journal_entry_id', v_live.reversed_by_id
      );
    END IF;
    v_reversal_id := v_live.reversed_by_id;
    SELECT * INTO v_reversal
    FROM public.journal_entries entry
    WHERE entry.id = v_reversal_id
      AND entry.company_id = p_company_id
      AND entry.status = 'posted'
      AND entry.source_type = 'storno'
      AND entry.reverses_id = v_live_id
    FOR UPDATE;
    IF NOT FOUND
       OR v_reversal.entry_date IS DISTINCT FROM p_reversal_date
       OR v_reversal.fiscal_period_id IS DISTINCT FROM v_reversal_period.id
       OR NOT public.supplier_reversal_lines_match(v_live_id, v_reversal_id) THEN
      RETURN jsonb_build_object(
        'status', 'conflict',
        'reason', 'recorded storno does not exactly reverse the live supplier entry',
        'company_id', p_company_id,
        'root_journal_entry_id', v_root_id,
        'original_journal_entry_id', p_original_journal_entry_id,
        'reversal_journal_entry_id', v_reversal_id
      );
    END IF;
  ELSIF v_live.status = 'posted' THEN
    IF v_existing_storno_count <> 0 OR v_live.reversed_by_id IS NOT NULL THEN
      RETURN jsonb_build_object(
        'status', 'conflict',
        'reason', 'posted live node already has contradictory storno evidence',
        'company_id', p_company_id,
        'root_journal_entry_id', v_root_id,
        'original_journal_entry_id', p_original_journal_entry_id,
        'reversal_journal_entry_id', v_live.reversed_by_id
      );
    END IF;

    INSERT INTO public.journal_entries (
      company_id, user_id, fiscal_period_id, voucher_number, voucher_series,
      entry_date, description, source_type, source_id, reverses_id, status
    ) VALUES (
      p_company_id, v_publication_user_id, v_reversal_period.id, 0,
      COALESCE(v_live.voucher_series, 'A'), p_reversal_date,
      'Makulering: ' || v_live.description, 'storno', v_live.source_id,
      v_live_id, 'draft'
    ) RETURNING id INTO v_reversal_id;

    INSERT INTO public.journal_entry_lines (
      journal_entry_id, account_number, account_id, debit_amount, credit_amount,
      currency, amount_in_currency, exchange_rate, line_description, sort_order,
      tax_code, dimensions
    )
    SELECT
      v_reversal_id, line.account_number, line.account_id,
      round(COALESCE(line.credit_amount, 0) * 100) / 100,
      round(COALESCE(line.debit_amount, 0) * 100) / 100,
      line.currency,
      CASE WHEN line.amount_in_currency IS NULL THEN NULL ELSE -line.amount_in_currency END,
      line.exchange_rate,
      'Makulering: ' || COALESCE(line.line_description, ''),
      line.sort_order, line.tax_code, line.dimensions
    FROM public.journal_entry_lines line
    WHERE line.journal_entry_id = v_live_id
    ORDER BY line.sort_order, line.id;

    SELECT committed.voucher_number
    INTO v_voucher_number
    FROM public.commit_journal_entry(
      p_company_id,
      v_reversal_id,
      CASE v_actor_type
        WHEN 'user' THEN 'user_accept'
        WHEN 'agent_chat' THEN 'agent'
        ELSE 'api_key'
      END,
      NULL,
      v_actor_type,
      v_actor_label
    ) committed;

    UPDATE public.journal_entries entry
    SET status = 'reversed', reversed_by_id = v_reversal_id
    WHERE entry.id = v_live_id
      AND entry.company_id = p_company_id
      AND entry.status = 'posted';
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Supplier payment live entry changed during reversal'
        USING ERRCODE = '40001';
    END IF;

    SELECT * INTO v_reversal
    FROM public.journal_entries entry
    WHERE entry.id = v_reversal_id
      AND entry.company_id = p_company_id;
  ELSE
    RAISE EXCEPTION 'Supplier payment live entry is not posted or exactly reversed'
      USING ERRCODE = '55000';
  END IF;

  INSERT INTO public.supplier_payment_reversals (
    company_id, requested_journal_entry_id, root_journal_entry_id,
    live_journal_entry_id, allocation_owner_journal_entry_id,
    reversal_journal_entry_id, reversal_date, reversal_fiscal_period_id,
    publication_user_id, actor_type, actor_id, actor_label,
    allocation_count, applied_at
  ) VALUES (
    p_company_id, p_original_journal_entry_id, v_root_id, v_live_id,
    v_allocation_owner_id, v_reversal_id, p_reversal_date,
    v_reversal_period.id, v_publication_user_id,
    v_actor_type, v_actor_id, v_actor_label, v_active_count, v_now
  ) RETURNING id INTO v_command_id;

  IF v_active_count > 0 THEN
    INSERT INTO public.supplier_invoice_payment_history (
      id, original_payment_id, company_id, supplier_invoice_id,
      allocation_owner_user_id, payment_date, amount, currency, exchange_rate,
      exchange_rate_difference, payment_exchange_rate, journal_entry_id,
      transaction_id, notes, allocation_created_at,
      lineage_root_journal_entry_id, reversed_live_journal_entry_id,
      reversed_by_journal_entry_id, reversal_command_id, reversed_at,
      reversal_actor_type, reversal_actor_id, reversal_actor_label
    )
    SELECT
      payment.id, payment.id, payment.company_id, payment.supplier_invoice_id,
      payment.user_id, payment.payment_date, payment.amount, payment.currency,
      payment.exchange_rate, payment.exchange_rate_difference,
      payment.payment_exchange_rate, payment.journal_entry_id,
      payment.transaction_id, payment.notes, payment.created_at,
      v_root_id, v_live_id, v_reversal_id, v_command_id, v_now,
      v_actor_type, v_actor_id, v_actor_label
    FROM public.supplier_invoice_payments payment
    WHERE payment.company_id = p_company_id
      AND payment.journal_entry_id = v_allocation_owner_id
    ORDER BY payment.id;

    PERFORM accounting_private.grant_accounting_command_capability(
      'supplier_payment_allocation_history_move',
      payment.company_id,
      payment.id
    )
    FROM public.supplier_invoice_payments payment
    WHERE payment.company_id = p_company_id
      AND payment.journal_entry_id = v_allocation_owner_id;

    DELETE FROM public.supplier_invoice_payments payment
    WHERE payment.company_id = p_company_id
      AND payment.journal_entry_id = v_allocation_owner_id;
    GET DIAGNOSTICS v_history_count = ROW_COUNT;
    IF v_history_count IS DISTINCT FROM v_active_count THEN
      RAISE EXCEPTION 'Supplier allocation history move was incomplete'
        USING ERRCODE = '55000';
    END IF;
    PERFORM accounting_private.revoke_accounting_command_capability(
      'supplier_payment_allocation_history_move',
      history.company_id,
      history.original_payment_id
    )
    FROM public.supplier_invoice_payment_history history
    WHERE history.reversal_command_id = v_command_id;

    UPDATE public.transactions transaction_row
    SET journal_entry_id = NULL,
        supplier_invoice_id = NULL
    WHERE transaction_row.company_id = p_company_id
      AND transaction_row.journal_entry_id = v_allocation_owner_id
      AND transaction_row.id IN (
        SELECT history.transaction_id
        FROM public.supplier_invoice_payment_history history
        WHERE history.reversal_command_id = v_command_id
          AND history.transaction_id IS NOT NULL
      );

    FOR v_invoice IN
      SELECT
        history.supplier_invoice_id,
        round(sum(history.amount) * 100) / 100 AS reversed_amount
      FROM public.supplier_invoice_payment_history history
      WHERE history.reversal_command_id = v_command_id
      GROUP BY history.supplier_invoice_id
      ORDER BY history.supplier_invoice_id
    LOOP
      UPDATE public.supplier_invoices invoice
      SET
        paid_amount = remaining.active_paid,
        remaining_amount = GREATEST(0, round((invoice.total - remaining.active_paid) * 100) / 100),
        status = CASE
          WHEN remaining.active_paid >= round(invoice.total * 100) / 100 - 0.005 THEN 'paid'
          WHEN remaining.active_paid > 0 THEN 'partially_paid'
          ELSE 'registered'
        END,
        paid_at = CASE
          WHEN remaining.active_paid >= round(invoice.total * 100) / 100 - 0.005
            THEN ((remaining.latest_payment_date::timestamp + interval '12 hours') AT TIME ZONE 'UTC')
          ELSE NULL
        END,
        payment_journal_entry_id = CASE
          WHEN invoice.payment_journal_entry_id = v_allocation_owner_id THEN NULL
          ELSE invoice.payment_journal_entry_id
        END,
        transaction_id = CASE
          WHEN invoice.transaction_id IN (
            SELECT history.transaction_id
            FROM public.supplier_invoice_payment_history history
            WHERE history.reversal_command_id = v_command_id
              AND history.supplier_invoice_id = invoice.id
          ) THEN NULL
          ELSE invoice.transaction_id
        END,
        updated_at = v_now
      FROM LATERAL (
        SELECT
          round(COALESCE(sum(active.amount), 0) * 100) / 100 AS active_paid,
          max(active.payment_date) AS latest_payment_date
        FROM public.supplier_invoice_payments active
        WHERE active.company_id = p_company_id
          AND active.supplier_invoice_id = v_invoice.supplier_invoice_id
      ) remaining
      WHERE invoice.id = v_invoice.supplier_invoice_id
        AND invoice.company_id = p_company_id;
      IF NOT FOUND THEN
        RAISE EXCEPTION 'Affected supplier invoice disappeared during reversal'
          USING ERRCODE = '40001';
      END IF;
    END LOOP;
  ELSIF v_has_compatibility THEN
    UPDATE public.supplier_invoices invoice
    SET status = 'registered',
        paid_amount = 0,
        remaining_amount = round(invoice.total * 100) / 100,
        paid_at = NULL,
        payment_journal_entry_id = NULL,
        transaction_id = CASE
          WHEN invoice.transaction_id IS NOT NULL AND EXISTS (
            SELECT 1 FROM public.transactions transaction_row
            WHERE transaction_row.id = invoice.transaction_id
              AND transaction_row.company_id = p_company_id
              AND transaction_row.journal_entry_id = v_root_id
          ) THEN NULL
          ELSE invoice.transaction_id
        END,
        updated_at = v_now
    WHERE invoice.id = v_compat_invoice.id
      AND invoice.company_id = p_company_id;
    UPDATE public.transactions transaction_row
    SET journal_entry_id = NULL,
        supplier_invoice_id = NULL
    WHERE transaction_row.id = v_compat_invoice.transaction_id
      AND transaction_row.company_id = p_company_id
      AND transaction_row.journal_entry_id = v_root_id;
  END IF;

  PERFORM set_config('gnubok.actor_type', v_actor_type, true);
  PERFORM set_config('gnubok.actor_label', COALESCE(v_actor_label, ''), true);

  v_committed_key := 'journal:' || v_reversal.id::text || ':committed';
  v_reversed_key := 'journal:' || v_live_id::text || ':reversed';
  v_committed_payload := jsonb_build_object(
    'companyId', p_company_id,
    'userId', v_publication_user_id,
    'entry', public.accounting_journal_entry_event_object(
      p_company_id, v_reversal.id
    )
  );
  v_reversed_payload := jsonb_build_object(
    'companyId', p_company_id,
    'userId', v_publication_user_id,
    'originalEntry', public.accounting_journal_entry_event_object(
      p_company_id, v_live_id
    ),
    'reversalEntry', public.accounting_journal_entry_event_object(
      p_company_id, v_reversal.id
    )
  );

  v_committed_publication := public.record_accounting_publication(
    p_company_id, v_committed_key, 'journal_entry.committed', v_reversal.id,
    v_publication_user_id, v_committed_payload
  );
  v_reversed_publication := public.record_accounting_publication(
    p_company_id, v_reversed_key, 'journal_entry.reversed', v_reversal.id,
    v_publication_user_id, v_reversed_payload
  );

  UPDATE public.supplier_payment_reversals command
  SET committed_publication_id = (v_committed_publication ->> 'publication_id')::uuid,
      reversed_publication_id = (v_reversed_publication ->> 'publication_id')::uuid
  WHERE command.id = v_command_id
    AND command.committed_publication_id IS NULL
    AND command.reversed_publication_id IS NULL;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Supplier reversal durable publication marker was not stored'
      USING ERRCODE = '55000';
  END IF;

  INSERT INTO public.audit_log (
    user_id, company_id, action, table_name, record_id, actor_id,
    old_state, new_state, description, actor_type, actor_label
  ) VALUES (
    v_publication_user_id, p_company_id, 'REVERSE',
    'supplier_invoice_payments', v_command_id, v_actor_id,
    jsonb_build_object('root_journal_entry_id', v_root_id, 'allocation_count', v_active_count),
    jsonb_build_object('reversal_journal_entry_id', v_reversal_id, 'history_count', v_active_count),
    'Atomically reversed supplier payment allocations and retained immutable history',
    v_actor_type, v_actor_label
  );

  RETURN jsonb_build_object(
    'status', 'applied',
    'company_id', p_company_id,
    'root_journal_entry_id', v_root_id,
    'original_journal_entry_id', p_original_journal_entry_id,
    'reversal_journal_entry_id', v_reversal_id,
    'actor_type', v_actor_type,
    'actor_id', v_actor_id,
    'actor_label', v_actor_label,
    'publications', jsonb_build_array(
      jsonb_build_object(
        'publication_id', v_committed_publication ->> 'publication_id',
        'event_key', v_committed_key,
        'event_type', 'journal_entry.committed'
      ),
      jsonb_build_object(
        'publication_id', v_reversed_publication ->> 'publication_id',
        'event_key', v_reversed_key,
        'event_type', 'journal_entry.reversed'
      )
    )
  );
END;
$function$;

REVOKE ALL ON FUNCTION public.apply_supplier_payment_reversal(
  uuid, uuid, uuid, date, text, uuid, text
) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.apply_supplier_payment_reversal(
  uuid, uuid, uuid, date, text, uuid, text
) TO authenticated, service_role;
COMMENT ON FUNCTION public.apply_supplier_payment_reversal(
  uuid, uuid, uuid, date, text, uuid, text
) IS
  'Atomically reverses the unique terminal supplier payment correction selected from the complete M2 lineage rooted at the explicit root ID.';

-- Posted vouchers are immutable. This replacement retains only the sanctioned
-- draft cleanup path and its existing owner/admin authorization.
CREATE OR REPLACE FUNCTION public.delete_last_voucher(
  p_company_id uuid,
  p_entry_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'pg_catalog', 'public'
AS $function$
DECLARE
  v_claims jsonb := COALESCE(NULLIF(current_setting('request.jwt.claims', true), '')::jsonb, '{}'::jsonb);
  v_role text := COALESCE(v_claims ->> 'role', '');
  v_entry public.journal_entries%ROWTYPE;
  v_lines jsonb;
  v_actor_id uuid;
BEGIN
  IF v_role = 'authenticated' THEN
    v_actor_id := auth.uid();
    IF NOT EXISTS (
      SELECT 1
      FROM public.company_members member
      WHERE member.company_id = p_company_id
        AND member.user_id = v_actor_id
        AND member.role IN ('owner', 'admin')
    ) THEN
      RAISE EXCEPTION 'Only company owners and admins can delete draft vouchers'
        USING ERRCODE = '42501';
    END IF;
  ELSIF v_role = 'service_role' THEN
    v_actor_id := NULL;
  ELSE
    RAISE EXCEPTION 'delete_last_voucher requires authenticated or service_role claims'
      USING ERRCODE = '42501';
  END IF;

  SELECT * INTO v_entry
  FROM public.journal_entries entry
  WHERE entry.id = p_entry_id
    AND entry.company_id = p_company_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Journal entry not found' USING ERRCODE = 'P0002';
  END IF;
  IF v_entry.status IS DISTINCT FROM 'draft' THEN
    RAISE EXCEPTION 'Posted and reversed vouchers cannot be deleted; use storno or correction'
      USING ERRCODE = '23514';
  END IF;
  IF v_entry.reverses_id IS NOT NULL OR v_entry.correction_of_id IS NOT NULL
     OR EXISTS (
       SELECT 1
       FROM public.supplier_invoice_payments payment
       WHERE payment.journal_entry_id = p_entry_id
     ) OR EXISTS (
       SELECT 1
       FROM public.supplier_invoice_payment_history history
       WHERE history.journal_entry_id = p_entry_id
          OR history.reversed_by_journal_entry_id = p_entry_id
     ) THEN
    RAISE EXCEPTION 'Draft voucher has retained accounting references'
      USING ERRCODE = '23514';
  END IF;

  SELECT COALESCE(jsonb_agg(to_jsonb(line) ORDER BY line.sort_order, line.id), '[]'::jsonb)
  INTO v_lines
  FROM public.journal_entry_lines line
  WHERE line.journal_entry_id = p_entry_id;

  PERFORM set_config('gnubok.allow_delete', 'true', true);
  UPDATE public.document_attachments
  SET journal_entry_id = NULL
  WHERE journal_entry_id = p_entry_id;
  DELETE FROM public.journal_entries entry
  WHERE entry.id = p_entry_id
    AND entry.company_id = p_company_id
    AND entry.status = 'draft';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Draft voucher changed during deletion' USING ERRCODE = '40001';
  END IF;

  INSERT INTO public.audit_log (
    user_id, company_id, action, table_name, record_id, actor_id,
    old_state, description, actor_type
  ) VALUES (
    v_entry.user_id, p_company_id, 'DELETE', 'journal_entries', p_entry_id,
    v_actor_id, to_jsonb(v_entry) || jsonb_build_object('lines', v_lines),
    'Deleted draft journal entry through draft-only delete_last_voucher',
    CASE WHEN v_role = 'service_role' THEN 'system' ELSE 'user' END
  );

  RETURN jsonb_build_object(
    'deleted', true,
    'voucher_series', v_entry.voucher_series,
    'voucher_number', v_entry.voucher_number,
    'was_draft', true
  );
END;
$function$;

REVOKE ALL ON FUNCTION public.delete_last_voucher(uuid, uuid)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.delete_last_voucher(uuid, uuid)
  TO authenticated, service_role;

NOTIFY pgrst, 'reload schema';
