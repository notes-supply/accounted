-- Retain exact supplier payment allocations after storno.
--
-- Before this migration, reverseEntry() deleted supplier_invoice_payments rows.
-- A match_batch_allocate voucher has source_id = NULL and carries its exact
-- invoice allocation only in those rows, so deletion made historical cutoff
-- reconstruction impossible. Existing rows remain active. Rows already deleted
-- before this migration cannot be reconstructed safely and are not backfilled.

ALTER TABLE public.supplier_invoice_payments
  ADD COLUMN reversed_at timestamptz,
  ADD COLUMN reversed_by_journal_entry_id uuid
    REFERENCES public.journal_entries(id) ON DELETE RESTRICT;

ALTER TABLE public.supplier_invoice_payments
  ADD CONSTRAINT supplier_invoice_payments_reversal_pair_check
  CHECK (
    (reversed_at IS NULL AND reversed_by_journal_entry_id IS NULL)
    OR (reversed_at IS NOT NULL AND reversed_by_journal_entry_id IS NOT NULL)
  );

COMMENT ON COLUMN public.supplier_invoice_payments.reversed_at IS
  'Timestamp at which this exact allocation was made inactive by storno. NULL means active.';
COMMENT ON COLUMN public.supplier_invoice_payments.reversed_by_journal_entry_id IS
  'Posted storno journal entry that reversed the allocation. Retained with ON DELETE RESTRICT for audit lineage.';

-- A reversed allocation must not prevent the same bank transaction or payment
-- voucher from being matched again. Keep the established transaction index
-- name. Journal-entry duplicates were historically possible because no
-- database constraint covered that pair. Keep those rows upgrade-safe, index
-- active lookups, and let the retention trigger prevent new duplicates.
DROP INDEX IF EXISTS public.idx_supplier_invoice_payments_tx_inv_unique;
CREATE UNIQUE INDEX idx_supplier_invoice_payments_tx_inv_unique
  ON public.supplier_invoice_payments (transaction_id, supplier_invoice_id)
  WHERE reversed_at IS NULL AND transaction_id IS NOT NULL;

CREATE INDEX idx_supplier_invoice_payments_je_inv_active
  ON public.supplier_invoice_payments (journal_entry_id, supplier_invoice_id)
  WHERE reversed_at IS NULL AND journal_entry_id IS NOT NULL;

CREATE OR REPLACE FUNCTION public.enforce_supplier_invoice_payment_retention()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'public'
AS $$
DECLARE
  v_reversal record;
  v_invoice_company_id uuid;
  v_journal record;
  v_transaction_company_id uuid;
BEGIN
  -- The repository's sanctioned sandbox teardown sets this transaction-local
  -- marker only after verifying every company for the user is a sandbox. Keep
  -- the per-row authoritative re-check here: the marker alone never unlocks a
  -- real company's retained allocations.
  IF TG_OP = 'DELETE'
     AND current_setting('gnubok.sandbox_cleanup', true) = 'true'
     AND EXISTS (
       SELECT 1
         FROM public.company_settings cs
        WHERE cs.company_id = OLD.company_id
          AND cs.is_sandbox = true
     ) THEN
    RETURN OLD;
  END IF;

  -- FK cleanup may clear journal/transaction pointers before the parent
  -- supplier invoice cascade deletes the allocation. Only nullification of
  -- those two pointers is accepted, and only for a reverified sandbox row.
  IF TG_OP = 'UPDATE'
     AND current_setting('gnubok.sandbox_cleanup', true) = 'true'
     AND EXISTS (
       SELECT 1
         FROM public.company_settings cs
        WHERE cs.company_id = OLD.company_id
          AND cs.is_sandbox = true
     )
     AND (
       to_jsonb(NEW) - ARRAY['journal_entry_id', 'transaction_id']
     ) IS NOT DISTINCT FROM (
       to_jsonb(OLD) - ARRAY['journal_entry_id', 'transaction_id']
     )
     AND (
       NEW.journal_entry_id IS NOT DISTINCT FROM OLD.journal_entry_id
       OR NEW.journal_entry_id IS NULL
     )
     AND (
       NEW.transaction_id IS NOT DISTINCT FROM OLD.transaction_id
       OR NEW.transaction_id IS NULL
     ) THEN
    RETURN NEW;
  END IF;

  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'supplier invoice payment allocations are retained and cannot be deleted'
      USING ERRCODE = '55000';
  END IF;

  IF TG_OP = 'INSERT' THEN
    IF NEW.reversed_at IS NOT NULL OR NEW.reversed_by_journal_entry_id IS NOT NULL THEN
      RAISE EXCEPTION 'new supplier invoice payment allocations must be active'
        USING ERRCODE = '23514';
    END IF;
    -- Bind every allocation to one company at the database boundary. RLS on
    -- the parent invoice is not enough: pointer FKs otherwise accept UUIDs
    -- from another tenant, and the retained row cannot later be repaired.
    SELECT si.company_id
      INTO v_invoice_company_id
      FROM public.supplier_invoices si
     WHERE si.id = NEW.supplier_invoice_id
     FOR SHARE;
    IF NOT FOUND OR v_invoice_company_id IS DISTINCT FROM NEW.company_id THEN
      RAISE EXCEPTION 'supplier payment invoice company mismatch'
        USING ERRCODE = '23514';
    END IF;

    IF NEW.journal_entry_id IS NOT NULL THEN
      SELECT je.company_id, je.status, je.source_type
        INTO v_journal
        FROM public.journal_entries je
       WHERE je.id = NEW.journal_entry_id
       FOR SHARE;
      IF NOT FOUND
         OR v_journal.company_id IS DISTINCT FROM NEW.company_id
         OR v_journal.status IS DISTINCT FROM 'posted'
         OR v_journal.source_type IN ('opening_balance', 'storno') THEN
        RAISE EXCEPTION 'supplier payment journal target mismatch'
          USING ERRCODE = '23514';
      END IF;
    END IF;

    IF NEW.transaction_id IS NOT NULL THEN
      SELECT t.company_id
        INTO v_transaction_company_id
        FROM public.transactions t
       WHERE t.id = NEW.transaction_id
       FOR SHARE;
      IF NOT FOUND
         OR v_transaction_company_id IS DISTINCT FROM NEW.company_id THEN
        RAISE EXCEPTION 'supplier payment transaction company mismatch'
          USING ERRCODE = '23514';
      END IF;
    END IF;


    IF NEW.journal_entry_id IS NOT NULL THEN
      -- A plain trigger existence check races. Serialize prospective inserts
      -- for this exact pair without validating or rewriting historical rows.
      PERFORM pg_advisory_xact_lock(
        hashtextextended(
          'supplier_invoice_payments:'
          || NEW.journal_entry_id::text
          || ':'
          || NEW.supplier_invoice_id::text,
          0
        )
      );

      IF EXISTS (
        SELECT 1
        FROM public.supplier_invoice_payments sip
        WHERE sip.journal_entry_id = NEW.journal_entry_id
          AND sip.supplier_invoice_id = NEW.supplier_invoice_id
          AND sip.reversed_at IS NULL
      ) THEN
        RAISE EXCEPTION 'duplicate active supplier payment journal allocation'
          USING ERRCODE = '23505',
                CONSTRAINT = 'supplier_invoice_payments_je_inv_active_unique';
      END IF;
    END IF;
    RETURN NEW;
  END IF;

  -- The allocation row is the durable invoice-level evidence that a batch
  -- voucher cannot reconstruct from its aggregate journal lines. Freeze every
  -- allocation field from insertion; reversal metadata is the only permitted
  -- transition. Historical repair scripts must run before this migration or
  -- create a new explicit forward repair contract instead of rewriting history.
  IF (
    to_jsonb(NEW) - ARRAY['reversed_at', 'reversed_by_journal_entry_id']
  ) IS DISTINCT FROM (
    to_jsonb(OLD) - ARRAY['reversed_at', 'reversed_by_journal_entry_id']
  ) THEN
    RAISE EXCEPTION 'supplier invoice payment allocation fields are immutable'
      USING ERRCODE = '55000';
  END IF;

  IF OLD.reversed_at IS NOT NULL THEN
    IF NEW.reversed_at IS DISTINCT FROM OLD.reversed_at
       OR NEW.reversed_by_journal_entry_id IS DISTINCT FROM OLD.reversed_by_journal_entry_id THEN
      RAISE EXCEPTION 'supplier invoice payment reversal metadata is immutable'
        USING ERRCODE = '55000';
    END IF;
    RETURN NEW;
  END IF;

  IF NEW.reversed_at IS NULL AND NEW.reversed_by_journal_entry_id IS NULL THEN
    RETURN NEW;
  END IF;

  IF NEW.reversed_at IS NULL OR NEW.reversed_by_journal_entry_id IS NULL THEN
    RAISE EXCEPTION 'supplier invoice payment reversal requires timestamp and storno journal entry'
      USING ERRCODE = '23514';
  END IF;

  IF OLD.journal_entry_id IS NULL THEN
    RAISE EXCEPTION 'cannot soft-reverse an unlinked legacy supplier payment allocation'
      USING ERRCODE = '23514';
  END IF;

  -- Reversal metadata is the durable idempotency marker for the atomic
  -- business-state transition below. Only that SECURITY DEFINER command may
  -- create the marker. A caller-set custom GUC is insufficient because direct
  -- authenticated writes do not run as a trusted migration/function owner.
  IF current_user NOT IN ('postgres', 'supabase_admin')
     OR current_setting('gnubok.supplier_payment_reversal', true)
        IS DISTINCT FROM (
          OLD.journal_entry_id::text
          || ':'
          || NEW.reversed_by_journal_entry_id::text
        ) THEN
    RAISE EXCEPTION 'supplier payment allocations must be reversed by the atomic command'
      USING ERRCODE = '55000';
  END IF;

  SELECT je.company_id, je.status, je.source_type, je.reverses_id, je.committed_at
    INTO v_reversal
  FROM public.journal_entries je
  WHERE je.id = NEW.reversed_by_journal_entry_id;

  IF NOT FOUND
     OR v_reversal.company_id IS DISTINCT FROM OLD.company_id
     OR v_reversal.status IS DISTINCT FROM 'posted'
     OR v_reversal.source_type IS DISTINCT FROM 'storno'
     OR v_reversal.reverses_id IS DISTINCT FROM OLD.journal_entry_id THEN
    RAISE EXCEPTION 'supplier invoice payment reversal must reference the exact posted storno'
      USING ERRCODE = '23514';
  END IF;

  -- The linked storno is freshly posted and normally has committed_at. Keep the
  -- fallback for the same legacy nullable-commit boundary as journal lineage.
  NEW.reversed_at := COALESCE(v_reversal.committed_at, now());
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS enforce_supplier_invoice_payment_retention
  ON public.supplier_invoice_payments;
CREATE TRIGGER enforce_supplier_invoice_payment_retention
  BEFORE INSERT OR UPDATE OR DELETE
  ON public.supplier_invoice_payments
  FOR EACH ROW EXECUTE FUNCTION public.enforce_supplier_invoice_payment_retention();

CREATE OR REPLACE FUNCTION public.write_supplier_invoice_payment_audit()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_actor_id uuid := auth.uid();
  v_action text;
  v_description text;
BEGIN
  IF current_setting('gnubok.sandbox_cleanup', true) = 'true' THEN
    RETURN NEW;
  END IF;

  v_action := CASE WHEN TG_OP = 'INSERT' THEN 'INSERT' ELSE 'UPDATE' END;
  v_description := CASE
    WHEN TG_OP = 'INSERT' THEN 'Created supplier_invoice_payments record'
    ELSE 'Reversed supplier invoice payment allocation'
  END;

  -- user_id remains the immutable allocation owner. actor_id is the
  -- authenticated member who performed the transition. Service-role and
  -- claimless database work has no user actor and is represented by NULL,
  -- matching the repository's security-event audit convention.
  INSERT INTO public.audit_log (
    user_id,
    company_id,
    action,
    table_name,
    record_id,
    actor_id,
    old_state,
    new_state,
    description,
    actor_type,
    actor_label
  ) VALUES (
    NEW.user_id,
    NEW.company_id,
    v_action,
    TG_TABLE_NAME,
    NEW.id,
    v_actor_id,
    CASE WHEN TG_OP = 'UPDATE' THEN to_jsonb(OLD) ELSE NULL END,
    to_jsonb(NEW),
    v_description,
    COALESCE(nullif(current_setting('gnubok.actor_type', true), ''), 'user'),
    nullif(current_setting('gnubok.actor_label', true), '')
  );

  RETURN NEW;
END;
$$;

-- Reversal metadata is behandlingshistorik. Use a table-specific audit trigger
-- so allocation ownership remains stable while the authenticated reverser is
-- recorded as actor_id. A generic trigger would misattribute Admin B's
-- reversal of Admin A's allocation to Admin A.
DROP TRIGGER IF EXISTS audit_supplier_invoice_payments
  ON public.supplier_invoice_payments;
CREATE TRIGGER audit_supplier_invoice_payments
  AFTER INSERT OR UPDATE ON public.supplier_invoice_payments
  FOR EACH ROW EXECUTE FUNCTION public.write_supplier_invoice_payment_audit();

-- Supplier reversal events use the same durable publication contract as
-- transaction-categorization compensation: one immutable logical identity per
-- event, event_log persistence, and webhook fanout in the same transaction as
-- the supplier business-state transition.
CREATE TABLE public.supplier_payment_reversal_event_outbox (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  company_id uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  original_journal_entry_id uuid NOT NULL,
  reversal_journal_entry_id uuid NOT NULL,
  event_type text NOT NULL CHECK (
    event_type IN ('journal_entry.committed', 'journal_entry.reversed')
  ),
  user_id uuid NOT NULL,
  payload jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  published_at timestamptz,
  UNIQUE (
    company_id,
    original_journal_entry_id,
    reversal_journal_entry_id,
    event_type
  )
);

ALTER TABLE public.supplier_payment_reversal_event_outbox ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.supplier_payment_reversal_event_outbox
  FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.record_supplier_payment_reversal_events(
  p_company_id uuid,
  p_original_journal_entry_id uuid,
  p_storno_journal_entry_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_original public.journal_entries%ROWTYPE;
  v_storno public.journal_entries%ROWTYPE;
  v_original_json jsonb;
  v_storno_json jsonb;
  v_user_id uuid;
  v_outbox_ids uuid[];
  v_outbox_count integer;
  v_published_count integer;
  v_event_log_count integer;
  v_delivery_count integer;
BEGIN
  SELECT je.*
    INTO v_original
    FROM public.journal_entries je
   WHERE je.id = p_original_journal_entry_id
     AND je.company_id = p_company_id
     AND je.status = 'reversed'
     AND je.reversed_by_id = p_storno_journal_entry_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'cannot publish an unverified supplier payment original'
      USING ERRCODE = '55000';
  END IF;

  IF (
    SELECT count(*)
      FROM public.journal_entries je
     WHERE je.company_id = p_company_id
       AND je.reverses_id = p_original_journal_entry_id
       AND je.source_type = 'storno'
       AND je.status = 'posted'
  ) <> 1 THEN
    RAISE EXCEPTION 'supplier payment reversal event lineage is ambiguous'
      USING ERRCODE = '55000';
  END IF;

  SELECT je.*
    INTO v_storno
    FROM public.journal_entries je
   WHERE je.id = p_storno_journal_entry_id
     AND je.company_id = p_company_id
     AND je.status = 'posted'
     AND je.source_type = 'storno'
     AND je.reverses_id = p_original_journal_entry_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'cannot publish an unverified supplier payment storno'
      USING ERRCODE = '55000';
  END IF;

  v_user_id := COALESCE(auth.uid(), v_original.user_id);
  IF v_user_id IS NULL OR NOT EXISTS (
    SELECT 1 FROM auth.users u WHERE u.id = v_user_id
  ) THEN
    RAISE EXCEPTION 'cannot publish supplier reversal events without a durable user';
  END IF;

  v_original_json := to_jsonb(v_original) || jsonb_build_object(
    'lines',
    COALESCE(
      (
        SELECT jsonb_agg(to_jsonb(jel) ORDER BY jel.sort_order, jel.id)
          FROM public.journal_entry_lines jel
         WHERE jel.journal_entry_id = p_original_journal_entry_id
      ),
      '[]'::jsonb
    )
  );
  v_storno_json := to_jsonb(v_storno) || jsonb_build_object(
    'lines',
    COALESCE(
      (
        SELECT jsonb_agg(to_jsonb(jel) ORDER BY jel.sort_order, jel.id)
          FROM public.journal_entry_lines jel
         WHERE jel.journal_entry_id = p_storno_journal_entry_id
      ),
      '[]'::jsonb
    )
  );

  INSERT INTO public.supplier_payment_reversal_event_outbox (
    company_id,
    original_journal_entry_id,
    reversal_journal_entry_id,
    event_type,
    user_id,
    payload
  ) VALUES
    (
      p_company_id,
      p_original_journal_entry_id,
      p_storno_journal_entry_id,
      'journal_entry.committed',
      v_user_id,
      jsonb_build_object(
        'entry', v_storno_json,
        'userId', v_user_id,
        'companyId', p_company_id
      )
    ),
    (
      p_company_id,
      p_original_journal_entry_id,
      p_storno_journal_entry_id,
      'journal_entry.reversed',
      v_user_id,
      jsonb_build_object(
        'originalEntry', v_original_json,
        'reversalEntry', v_storno_json,
        'userId', v_user_id,
        'companyId', p_company_id
      )
    )
  ON CONFLICT (
    company_id,
    original_journal_entry_id,
    reversal_journal_entry_id,
    event_type
  ) DO NOTHING;

  PERFORM 1
    FROM public.supplier_payment_reversal_event_outbox o
   WHERE o.company_id = p_company_id
     AND o.original_journal_entry_id = p_original_journal_entry_id
     AND o.reversal_journal_entry_id = p_storno_journal_entry_id
   ORDER BY o.event_type
   FOR UPDATE;

  SELECT count(*)::integer,
         count(*) FILTER (WHERE o.published_at IS NOT NULL)::integer,
         array_agg(o.id ORDER BY o.event_type)
    INTO v_outbox_count, v_published_count, v_outbox_ids
    FROM public.supplier_payment_reversal_event_outbox o
   WHERE o.company_id = p_company_id
     AND o.original_journal_entry_id = p_original_journal_entry_id
     AND o.reversal_journal_entry_id = p_storno_journal_entry_id;

  IF v_outbox_count <> 2 OR COALESCE(array_length(v_outbox_ids, 1), 0) <> 2 THEN
    RAISE EXCEPTION 'supplier payment reversal event outbox is incomplete'
      USING ERRCODE = '55000';
  END IF;
  IF v_published_count NOT IN (0, 2) THEN
    RAISE EXCEPTION 'supplier payment reversal event publication is partial'
      USING ERRCODE = '55000';
  END IF;

  IF v_published_count = 0 THEN
    INSERT INTO public.event_log (
      user_id,
      company_id,
      event_type,
      entity_id,
      data,
      outbox_event_id
    )
    SELECT
      o.user_id,
      o.company_id,
      o.event_type,
      o.reversal_journal_entry_id,
      o.payload - 'userId' - 'companyId',
      o.id
    FROM public.supplier_payment_reversal_event_outbox o
    WHERE o.id = ANY(v_outbox_ids)
    ON CONFLICT (outbox_event_id) WHERE outbox_event_id IS NOT NULL DO NOTHING;

    PERFORM 1
      FROM public.webhooks w
     WHERE w.company_id = p_company_id
       AND w.event_type IN ('journal_entry.committed', 'journal_entry.reversed')
       AND w.active = true
       AND w.disabled_at IS NULL
     FOR SHARE;

    INSERT INTO public.webhook_deliveries (
      webhook_id,
      company_id,
      event_type,
      payload,
      api_version,
      previous_attributes,
      request_id,
      outbox_event_id
    )
    SELECT
      w.id,
      o.company_id,
      o.event_type,
      o.payload - 'userId',
      w.api_version_pinned,
      NULL,
      'siprev_' || o.id::text,
      o.id
    FROM public.supplier_payment_reversal_event_outbox o
    JOIN public.webhooks w
      ON w.company_id = o.company_id
     AND w.event_type = o.event_type
     AND w.active = true
     AND w.disabled_at IS NULL
    WHERE o.id = ANY(v_outbox_ids)
    ON CONFLICT (webhook_id, outbox_event_id)
      WHERE webhook_id IS NOT NULL AND outbox_event_id IS NOT NULL
      DO NOTHING;
  END IF;

  SELECT count(*)::integer
    INTO v_event_log_count
    FROM public.event_log e
    JOIN public.supplier_payment_reversal_event_outbox o
      ON o.id = e.outbox_event_id
   WHERE o.id = ANY(v_outbox_ids)
     AND e.company_id = o.company_id
     AND e.user_id = o.user_id
     AND e.event_type = o.event_type
     AND e.entity_id = o.reversal_journal_entry_id
     AND e.data = o.payload - 'userId' - 'companyId';
  IF v_event_log_count <> 2 THEN
    RAISE EXCEPTION 'supplier reversal event_log persistence could not be verified'
      USING ERRCODE = '55000';
  END IF;

  IF EXISTS (
    SELECT 1
      FROM public.webhooks w
      JOIN public.supplier_payment_reversal_event_outbox o
        ON o.company_id = w.company_id
       AND o.event_type = w.event_type
      LEFT JOIN public.webhook_deliveries d
        ON d.webhook_id = w.id
       AND d.outbox_event_id = o.id
       AND d.company_id = o.company_id
       AND d.event_type = o.event_type
       AND d.payload = o.payload - 'userId'
     WHERE o.id = ANY(v_outbox_ids)
       AND w.active = true
       AND w.disabled_at IS NULL
       AND d.id IS NULL
  ) THEN
    RAISE EXCEPTION 'supplier reversal webhook fanout could not be verified'
      USING ERRCODE = '55000';
  END IF;

  UPDATE public.supplier_payment_reversal_event_outbox o
     SET published_at = COALESCE(o.published_at, now())
   WHERE o.id = ANY(v_outbox_ids);

  SELECT count(*)::integer
    INTO v_delivery_count
    FROM public.webhook_deliveries d
   WHERE d.outbox_event_id = ANY(v_outbox_ids);

  RETURN jsonb_build_object(
    'status', CASE WHEN v_published_count = 2 THEN 'already_published' ELSE 'published' END,
    'event_outbox_ids', to_jsonb(v_outbox_ids),
    'event_log_count', v_event_log_count,
    'webhook_delivery_count', v_delivery_count
  );
END;
$$;

REVOKE ALL ON FUNCTION public.record_supplier_payment_reversal_events(
  uuid, uuid, uuid
) FROM PUBLIC, anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION public.apply_supplier_payment_reversal(
  p_company_id uuid,
  p_original_journal_entry_id uuid,
  p_storno_journal_entry_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_original record;
  v_storno record;
  v_invoice record;
  v_legacy_invoice record;
  v_v1_invoice record;
  v_role text := COALESCE(auth.role(), '');
  v_total_count integer;
  v_active_count integer;
  v_matching_reversed_count integer;
  v_invoice_count integer;
  v_expected_invoice_count integer;
  v_updated_count integer;
  v_released_count integer;
  v_reversed_at timestamptz;
  v_legacy_status text;
  v_v1_status text;
  v_v1_line_count integer;
  v_v1_2440_count integer;
  v_v1_2440_debit_count integer;
  v_v1_malformed_line_count integer;
  v_v1_marker_count integer;
  v_v1_total_debit numeric;
  v_v1_total_credit numeric;
  v_v1_payment_amount numeric;
  v_v1_restored_paid numeric;
  v_event_publication jsonb;
BEGIN
  IF v_role = 'service_role' THEN
    NULL;
  ELSIF v_role = 'authenticated'
        AND public.caller_can_write_company(p_company_id) THEN
    NULL;
  ELSE
    RAISE EXCEPTION 'unauthorized supplier payment reversal for company %', p_company_id
      USING ERRCODE = '42501';
  END IF;

  -- Lock both journal rows in UUID order so concurrent retries share one
  -- linearization point without introducing inverse lock ordering.
  PERFORM je.id
    FROM public.journal_entries je
   WHERE je.id = ANY (
     ARRAY[p_original_journal_entry_id, p_storno_journal_entry_id]
   )
   ORDER BY je.id
   FOR SHARE;

  SELECT je.company_id, je.status, je.source_type, je.source_id, je.reversed_by_id
    INTO v_original
    FROM public.journal_entries je
   WHERE je.id = p_original_journal_entry_id;
  IF NOT FOUND
     OR v_original.company_id IS DISTINCT FROM p_company_id
     OR v_original.status IS DISTINCT FROM 'reversed'
     OR v_original.reversed_by_id IS DISTINCT FROM p_storno_journal_entry_id THEN
    RAISE EXCEPTION 'supplier payment reversal original journal entry mismatch'
      USING ERRCODE = '23514';
  END IF;

  SELECT je.company_id, je.status, je.source_type, je.reverses_id, je.committed_at
    INTO v_storno
    FROM public.journal_entries je
   WHERE je.id = p_storno_journal_entry_id;
  IF NOT FOUND
     OR v_storno.company_id IS DISTINCT FROM p_company_id
     OR v_storno.status IS DISTINCT FROM 'posted'
     OR v_storno.source_type IS DISTINCT FROM 'storno'
     OR v_storno.reverses_id IS DISTINCT FROM p_original_journal_entry_id THEN
    RAISE EXCEPTION 'supplier payment reversal must reference the exact posted storno'
      USING ERRCODE = '23514';
  END IF;
  v_reversed_at := COALESCE(v_storno.committed_at, now());

  -- Lock every historical and active allocation for the original voucher.
  -- Inspecting all rows makes a mixed active/reversed state a conflict rather
  -- than silently completing a transition that started outside this command.
  PERFORM sip.id
    FROM public.supplier_invoice_payments sip
   WHERE sip.journal_entry_id = p_original_journal_entry_id
   ORDER BY sip.id
   FOR UPDATE;

  SELECT count(*)::integer,
         count(*) FILTER (WHERE sip.reversed_at IS NULL)::integer,
         count(*) FILTER (
           WHERE sip.reversed_at IS NOT NULL
             AND sip.reversed_by_journal_entry_id = p_storno_journal_entry_id
             AND (
               v_storno.committed_at IS NULL
               OR sip.reversed_at = v_storno.committed_at
             )
         )::integer
    INTO v_total_count, v_active_count, v_matching_reversed_count
    FROM public.supplier_invoice_payments sip
   WHERE sip.journal_entry_id = p_original_journal_entry_id;

  IF EXISTS (
    SELECT 1
      FROM public.supplier_invoice_payments sip
     WHERE sip.journal_entry_id = p_original_journal_entry_id
       AND (
         sip.company_id IS DISTINCT FROM p_company_id
         OR sip.amount IS NULL
         OR round(sip.amount, 2) <= 0
       )
  ) THEN
    RAISE EXCEPTION 'supplier payment reversal allocation ownership or amount mismatch'
      USING ERRCODE = '55000';
  END IF;
  IF v_original.source_type NOT IN (
    'supplier_invoice_paid',
    'supplier_invoice_cash_payment',
    'manual'
  ) THEN
    RAISE EXCEPTION 'supplier payment reversal original journal entry mismatch'
      USING ERRCODE = '23514';
  END IF;

  -- Manual vouchers are supplier-payment targets only when the sanctioned
  -- voucher-link flow left exact retained allocations. Never infer supplier
  -- semantics for an allocation-less manual reversal.
  IF v_original.source_type = 'manual' AND v_total_count = 0 THEN
    RAISE EXCEPTION 'manual supplier payment reversal has no retained allocations'
      USING ERRCODE = '55000';
  END IF;


  IF v_total_count = 0 THEN
    IF v_original.source_type = 'supplier_invoice_paid' THEN
      -- Compatibility recovery for the v1 mark-paid ordering: the posted
      -- voucher and invoice mutation may exist even when its explicitly
      -- non-blocking allocation insert failed. The exact source pointer,
      -- one unambiguous 2440 debit, the invoice before-state, and the durable
      -- event outbox marker bound this path. No other allocation-free payment
      -- source acquires this capability.
      IF v_original.source_id IS NULL THEN
        RAISE EXCEPTION 'supplier payment recovery has no source invoice'
          USING ERRCODE = '55000';
      END IF;

      SELECT si.id, si.company_id, si.status, si.paid_at, si.paid_amount,
             si.remaining_amount, si.total, si.due_date,
             si.payment_journal_entry_id, si.is_credit_note
        INTO v_v1_invoice
        FROM public.supplier_invoices si
       WHERE si.id = v_original.source_id
       FOR UPDATE;
      IF NOT FOUND OR v_v1_invoice.company_id IS DISTINCT FROM p_company_id THEN
        RAISE EXCEPTION 'supplier payment recovery invoice ownership mismatch'
          USING ERRCODE = '55000';
      END IF;

      SELECT count(*)::integer,
             count(*) FILTER (
               WHERE jel.account_number = '2440'
             )::integer,
             count(*) FILTER (
               WHERE jel.account_number = '2440'
                 AND round(COALESCE(jel.debit_amount, 0), 2) > 0
                 AND round(COALESCE(jel.credit_amount, 0), 2) = 0
             )::integer,
             count(*) FILTER (
               WHERE jel.account_number IS NULL
                  OR btrim(jel.account_number) = ''
                  OR jel.debit_amount IS NULL
                  OR jel.credit_amount IS NULL
                  OR jel.debit_amount < 0
                  OR jel.credit_amount < 0
                  OR (
                    (round(jel.debit_amount, 2) > 0)::integer
                    + (round(jel.credit_amount, 2) > 0)::integer
                  ) <> 1
             )::integer,
             round(COALESCE(sum(jel.debit_amount), 0), 2),
             round(COALESCE(sum(jel.credit_amount), 0), 2),
             round(
               COALESCE(
                 sum(jel.debit_amount) FILTER (
                   WHERE jel.account_number = '2440'
                 ),
                 0
               ),
               2
             )
        INTO v_v1_line_count,
             v_v1_2440_count,
             v_v1_2440_debit_count,
             v_v1_malformed_line_count,
             v_v1_total_debit,
             v_v1_total_credit,
             v_v1_payment_amount
        FROM public.journal_entry_lines jel
       WHERE jel.journal_entry_id = p_original_journal_entry_id;

      IF v_v1_line_count < 2
         OR v_v1_2440_count <> 1
         OR v_v1_2440_debit_count <> 1
         OR v_v1_malformed_line_count <> 0
         OR v_v1_payment_amount <= 0
         OR v_v1_total_debit <= 0
         OR v_v1_total_debit IS DISTINCT FROM v_v1_total_credit THEN
        RAISE EXCEPTION 'supplier payment recovery journal line shape is ambiguous'
          USING ERRCODE = '55000';
      END IF;

      IF (
        SELECT count(*)
          FROM public.journal_entries je
         WHERE je.company_id = p_company_id
           AND je.reverses_id = p_original_journal_entry_id
           AND je.source_type = 'storno'
           AND je.status = 'posted'
      ) <> 1 THEN
        RAISE EXCEPTION 'supplier payment recovery storno lineage is ambiguous'
          USING ERRCODE = '55000';
      END IF;

      -- A transaction belongs to this recovery only through the exact original
      -- voucher pointer. Foreign-tenant and conflicting invoice pointers are
      -- rejected before any state change.
      PERFORM t.id
        FROM public.transactions t
       WHERE t.journal_entry_id = p_original_journal_entry_id
       ORDER BY t.id
       FOR UPDATE;

      IF EXISTS (
        SELECT 1
          FROM public.transactions t
         WHERE t.journal_entry_id = p_original_journal_entry_id
           AND (
             t.company_id IS DISTINCT FROM p_company_id
             OR t.invoice_id IS NOT NULL
             OR (
               t.supplier_invoice_id IS NOT NULL
               AND t.supplier_invoice_id IS DISTINCT FROM v_v1_invoice.id
             )
           )
      ) THEN
        RAISE EXCEPTION 'supplier payment recovery transaction ownership conflict'
          USING ERRCODE = '55000';
      END IF;

      SELECT count(*)::integer
        INTO v_v1_marker_count
        FROM public.supplier_payment_reversal_event_outbox o
       WHERE o.company_id = p_company_id
         AND o.original_journal_entry_id = p_original_journal_entry_id
         AND o.reversal_journal_entry_id = p_storno_journal_entry_id;

      IF v_v1_marker_count = 2 THEN
        IF v_v1_invoice.payment_journal_entry_id = p_original_journal_entry_id
           OR EXISTS (
             SELECT 1
               FROM public.transactions t
              WHERE t.journal_entry_id = p_original_journal_entry_id
           ) THEN
          RAISE EXCEPTION 'supplier payment recovery marker conflicts with current pointers'
            USING ERRCODE = '55000';
        END IF;
        v_event_publication := public.record_supplier_payment_reversal_events(
          p_company_id,
          p_original_journal_entry_id,
          p_storno_journal_entry_id
        );
        RETURN jsonb_build_object(
          'ok', true,
          'status', 'already_applied_v1_recovery',
          'allocation_count', 0,
          'invoice_count', 1,
          'transaction_count', 0,
          'event_publication', v_event_publication
        );
      ELSIF v_v1_marker_count <> 0 THEN
        RAISE EXCEPTION 'supplier payment recovery marker is incomplete'
          USING ERRCODE = '55000';
      END IF;

      IF v_v1_invoice.is_credit_note IS DISTINCT FROM false
         OR v_v1_invoice.payment_journal_entry_id
            IS DISTINCT FROM p_original_journal_entry_id
         OR v_v1_invoice.status NOT IN ('paid', 'partially_paid')
         OR round(COALESCE(v_v1_invoice.paid_amount, 0), 2)
            < v_v1_payment_amount
         OR round(COALESCE(v_v1_invoice.paid_amount, 0), 2)
            > round(v_v1_invoice.total, 2)
         OR round(
           COALESCE(v_v1_invoice.remaining_amount, v_v1_invoice.total),
           2
         ) IS DISTINCT FROM round(
           v_v1_invoice.total - COALESCE(v_v1_invoice.paid_amount, 0),
           2
         )
         OR (
           v_v1_invoice.status = 'paid'
           AND (
             round(COALESCE(v_v1_invoice.remaining_amount, 0), 2) <> 0
             OR v_v1_invoice.paid_at IS NULL
           )
         )
         OR (
           v_v1_invoice.status = 'partially_paid'
           AND (
             round(COALESCE(v_v1_invoice.paid_amount, 0), 2) <= 0
             OR round(COALESCE(v_v1_invoice.remaining_amount, 0), 2) <= 0
             OR v_v1_invoice.paid_at IS NOT NULL
           )
         ) THEN
        RAISE EXCEPTION 'supplier payment recovery invoice state conflict'
          USING ERRCODE = '55000';
      END IF;

      v_v1_restored_paid := round(
        v_v1_invoice.paid_amount - v_v1_payment_amount,
        2
      );
      IF v_v1_restored_paid < 0 THEN
        RAISE EXCEPTION 'supplier payment recovery amount exceeds paid state'
          USING ERRCODE = '55000';
      END IF;
      v_v1_status := CASE
        WHEN v_v1_restored_paid > 0 THEN 'partially_paid'
        WHEN v_v1_invoice.due_date IS NOT NULL
         AND v_v1_invoice.due_date < current_date THEN 'overdue'
        ELSE 'approved'
      END;

      UPDATE public.supplier_invoices si
         SET status = v_v1_status,
             paid_amount = v_v1_restored_paid,
             remaining_amount = round(si.total - v_v1_restored_paid, 2),
             paid_at = NULL,
             payment_journal_entry_id = NULL
       WHERE si.id = v_v1_invoice.id
         AND si.company_id = p_company_id
         AND si.payment_journal_entry_id = p_original_journal_entry_id;
      GET DIAGNOSTICS v_updated_count = ROW_COUNT;
      IF v_updated_count <> 1 THEN
        RAISE EXCEPTION 'supplier payment recovery did not restore its invoice'
          USING ERRCODE = '55000';
      END IF;

      UPDATE public.transactions t
         SET journal_entry_id = NULL,
             supplier_invoice_id = NULL,
             is_business = NULL,
             category = NULL
       WHERE t.company_id = p_company_id
         AND t.journal_entry_id = p_original_journal_entry_id
         AND t.invoice_id IS NULL
         AND (
           t.supplier_invoice_id IS NULL
           OR t.supplier_invoice_id = v_v1_invoice.id
         );
      GET DIAGNOSTICS v_released_count = ROW_COUNT;
      IF EXISTS (
        SELECT 1
          FROM public.transactions t
         WHERE t.journal_entry_id = p_original_journal_entry_id
      ) THEN
        RAISE EXCEPTION 'supplier payment recovery left a conflicting transaction pointer'
          USING ERRCODE = '55000';
      END IF;

      v_event_publication := public.record_supplier_payment_reversal_events(
        p_company_id,
        p_original_journal_entry_id,
        p_storno_journal_entry_id
      );
      RETURN jsonb_build_object(
        'ok', true,
        'status', 'applied_v1_recovery',
        'allocation_count', 0,
        'invoice_count', 1,
        'transaction_count', v_released_count,
        'event_publication', v_event_publication
      );
    END IF;

    -- Deliberately bounded compatibility path: old cash-method full-payment
    -- vouchers were source-linked before allocation rows became mandatory.
    -- The exact current payment pointer is the before-state marker; the fully
    -- restored invoice state is the retry marker.
    IF v_original.source_type IS DISTINCT FROM 'supplier_invoice_cash_payment'
       OR v_original.source_id IS NULL THEN
      RAISE EXCEPTION 'supplier payment reversal has no retained allocations'
        USING ERRCODE = '55000';
    END IF;

    SELECT si.id, si.company_id, si.status, si.paid_at, si.paid_amount,
           si.remaining_amount, si.total, si.due_date,
           si.payment_journal_entry_id
      INTO v_legacy_invoice
      FROM public.supplier_invoices si
     WHERE si.id = v_original.source_id
     FOR UPDATE;
    IF NOT FOUND OR v_legacy_invoice.company_id IS DISTINCT FROM p_company_id THEN
      RAISE EXCEPTION 'legacy supplier cash payment invoice mismatch'
        USING ERRCODE = '55000';
    END IF;

    v_legacy_status := CASE
      WHEN v_legacy_invoice.due_date IS NOT NULL
       AND v_legacy_invoice.due_date < current_date THEN 'overdue'
      ELSE 'approved'
    END;

    IF v_legacy_invoice.payment_journal_entry_id IS NULL
       AND round(COALESCE(v_legacy_invoice.paid_amount, 0), 2) = 0
       AND round(
         COALESCE(v_legacy_invoice.remaining_amount, v_legacy_invoice.total),
         2
       ) = round(v_legacy_invoice.total, 2)
       AND v_legacy_invoice.paid_at IS NULL
       AND v_legacy_invoice.status = v_legacy_status THEN
      v_event_publication := public.record_supplier_payment_reversal_events(
        p_company_id,
        p_original_journal_entry_id,
        p_storno_journal_entry_id
      );
      RETURN jsonb_build_object(
        'ok', true,
        'status', 'already_applied_legacy',
        'allocation_count', 0,
        'invoice_count', 1,
        'transaction_count', 0,
        'event_publication', v_event_publication
      );
    END IF;

    IF v_legacy_invoice.payment_journal_entry_id
         IS DISTINCT FROM p_original_journal_entry_id
       OR v_legacy_invoice.status IS DISTINCT FROM 'paid'
       OR round(COALESCE(v_legacy_invoice.paid_amount, 0), 2)
          IS DISTINCT FROM round(v_legacy_invoice.total, 2)
       OR round(
         COALESCE(v_legacy_invoice.remaining_amount, v_legacy_invoice.total),
         2
       ) IS DISTINCT FROM 0::numeric THEN
      RAISE EXCEPTION 'legacy supplier cash payment invoice state conflict'
        USING ERRCODE = '55000';
    END IF;

    UPDATE public.supplier_invoices si
       SET status = v_legacy_status,
           paid_amount = 0,
           remaining_amount = round(si.total, 2),
           paid_at = NULL,
           payment_journal_entry_id = NULL
     WHERE si.id = v_legacy_invoice.id
       AND si.company_id = p_company_id;

    UPDATE public.transactions t
       SET journal_entry_id = NULL,
           supplier_invoice_id = NULL,
           is_business = NULL,
           category = NULL
     WHERE t.company_id = p_company_id
       AND t.journal_entry_id = p_original_journal_entry_id;
    GET DIAGNOSTICS v_released_count = ROW_COUNT;

    v_event_publication := public.record_supplier_payment_reversal_events(
      p_company_id,
      p_original_journal_entry_id,
      p_storno_journal_entry_id
    );
    RETURN jsonb_build_object(
      'ok', true,
      'status', 'applied_legacy',
      'allocation_count', 0,
      'invoice_count', 1,
      'transaction_count', v_released_count,
      'event_publication', v_event_publication
    );
  END IF;

  IF v_active_count = 0 AND v_matching_reversed_count = v_total_count THEN
    v_event_publication := public.record_supplier_payment_reversal_events(
      p_company_id,
      p_original_journal_entry_id,
      p_storno_journal_entry_id
    );
    RETURN jsonb_build_object(
      'ok', true,
      'status', 'already_applied',
      'allocation_count', v_total_count,
      'invoice_count', (
        SELECT count(DISTINCT sip.supplier_invoice_id)
          FROM public.supplier_invoice_payments sip
         WHERE sip.journal_entry_id = p_original_journal_entry_id
      ),
      'transaction_count', 0,
      'event_publication', v_event_publication
    );
  END IF;

  IF v_active_count IS DISTINCT FROM v_total_count
     OR v_matching_reversed_count <> 0 THEN
    RAISE EXCEPTION 'supplier payment reversal allocation state conflict'
      USING ERRCODE = '55000';
  END IF;

  -- Lock every affected invoice once in UUID order. The aggregate below is
  -- grouped by invoice, so historical duplicate allocation rows subtract one
  -- combined amount through one UPDATE of each invoice.
  PERFORM si.id
    FROM public.supplier_invoices si
   WHERE si.id IN (
     SELECT sip.supplier_invoice_id
       FROM public.supplier_invoice_payments sip
      WHERE sip.journal_entry_id = p_original_journal_entry_id
        AND sip.reversed_at IS NULL
   )
   ORDER BY si.id
   FOR UPDATE;

  SELECT count(DISTINCT sip.supplier_invoice_id)::integer
    INTO v_expected_invoice_count
    FROM public.supplier_invoice_payments sip
   WHERE sip.journal_entry_id = p_original_journal_entry_id
     AND sip.reversed_at IS NULL;
  SELECT count(*)::integer
    INTO v_invoice_count
    FROM public.supplier_invoices si
   WHERE si.company_id = p_company_id
     AND si.id IN (
       SELECT sip.supplier_invoice_id
         FROM public.supplier_invoice_payments sip
        WHERE sip.journal_entry_id = p_original_journal_entry_id
          AND sip.reversed_at IS NULL
     );
  IF v_invoice_count IS DISTINCT FROM v_expected_invoice_count THEN
    RAISE EXCEPTION 'supplier payment reversal invoice ownership mismatch'
      USING ERRCODE = '55000';
  END IF;

  FOR v_invoice IN
    SELECT si.id, si.status, si.paid_amount, amounts.payment_amount
      FROM public.supplier_invoices si
      JOIN (
        SELECT sip.supplier_invoice_id,
               round(sum(sip.amount), 2) AS payment_amount
          FROM public.supplier_invoice_payments sip
         WHERE sip.journal_entry_id = p_original_journal_entry_id
           AND sip.reversed_at IS NULL
         GROUP BY sip.supplier_invoice_id
      ) amounts ON amounts.supplier_invoice_id = si.id
     WHERE si.company_id = p_company_id
     ORDER BY si.id
  LOOP
    IF v_invoice.status NOT IN ('paid', 'partially_paid')
       OR round(COALESCE(v_invoice.paid_amount, 0), 2)
          < v_invoice.payment_amount THEN
      RAISE EXCEPTION 'supplier payment reversal invoice state conflict for %',
        v_invoice.id
        USING ERRCODE = '55000';
    END IF;
  END LOOP;

  -- Allocation-linked transaction IDs must still be owned by this original
  -- payment state. A rematched/current pointer is a conflict, never something
  -- this reversal may clear.
  IF EXISTS (
    SELECT 1
      FROM public.supplier_invoice_payments sip
      JOIN public.transactions t ON t.id = sip.transaction_id
     WHERE sip.journal_entry_id = p_original_journal_entry_id
       AND sip.reversed_at IS NULL
       AND (
         t.company_id IS DISTINCT FROM p_company_id
         OR (
           t.journal_entry_id IS NOT NULL
           AND t.journal_entry_id IS DISTINCT FROM p_original_journal_entry_id
         )
         OR t.invoice_id IS NOT NULL
         OR (
           t.supplier_invoice_id IS NOT NULL
           AND t.supplier_invoice_id IS DISTINCT FROM sip.supplier_invoice_id
         )
       )
  ) OR EXISTS (
    SELECT 1
      FROM public.supplier_invoice_payments selected
      JOIN public.supplier_invoice_payments current_allocation
        ON current_allocation.transaction_id = selected.transaction_id
       AND current_allocation.reversed_at IS NULL
       AND current_allocation.journal_entry_id
           IS DISTINCT FROM p_original_journal_entry_id
     WHERE selected.journal_entry_id = p_original_journal_entry_id
       AND selected.reversed_at IS NULL
  ) THEN
    RAISE EXCEPTION 'supplier payment reversal transaction ownership conflict'
      USING ERRCODE = '55000';
  END IF;

  WITH amounts AS (
    SELECT sip.supplier_invoice_id,
           round(sum(sip.amount), 2) AS payment_amount
      FROM public.supplier_invoice_payments sip
     WHERE sip.journal_entry_id = p_original_journal_entry_id
       AND sip.reversed_at IS NULL
     GROUP BY sip.supplier_invoice_id
  ),
  restored AS (
    SELECT si.id,
           GREATEST(
             0,
             round(COALESCE(si.paid_amount, 0) - amounts.payment_amount, 2)
           ) AS paid_amount
      FROM public.supplier_invoices si
      JOIN amounts ON amounts.supplier_invoice_id = si.id
     WHERE si.company_id = p_company_id
  )
  UPDATE public.supplier_invoices si
     SET paid_amount = restored.paid_amount,
         remaining_amount = round(si.total - restored.paid_amount, 2),
         status = CASE
           WHEN restored.paid_amount > 0 THEN 'partially_paid'
           WHEN si.due_date IS NOT NULL AND si.due_date < current_date THEN 'overdue'
           ELSE 'approved'
         END,
         paid_at = NULL,
         payment_journal_entry_id = CASE
           WHEN si.payment_journal_entry_id = p_original_journal_entry_id THEN NULL
           ELSE si.payment_journal_entry_id
         END
    FROM restored
   WHERE si.id = restored.id
     AND si.company_id = p_company_id;
  GET DIAGNOSTICS v_updated_count = ROW_COUNT;
  IF v_updated_count IS DISTINCT FROM v_invoice_count THEN
    RAISE EXCEPTION 'supplier payment reversal did not restore every invoice'
      USING ERRCODE = '55000';
  END IF;

  UPDATE public.transactions t
     SET journal_entry_id = NULL,
         supplier_invoice_id = NULL,
         is_business = NULL,
         category = NULL
   WHERE t.company_id = p_company_id
     AND (
       t.journal_entry_id = p_original_journal_entry_id
       OR (
         t.id IN (
           SELECT sip.transaction_id
             FROM public.supplier_invoice_payments sip
            WHERE sip.journal_entry_id = p_original_journal_entry_id
              AND sip.reversed_at IS NULL
              AND sip.transaction_id IS NOT NULL
         )
         AND t.journal_entry_id IS NULL
         AND t.invoice_id IS NULL
         AND (
           t.supplier_invoice_id IS NULL
           OR EXISTS (
             SELECT 1
               FROM public.supplier_invoice_payments sip
              WHERE sip.journal_entry_id = p_original_journal_entry_id
                AND sip.reversed_at IS NULL
                AND sip.transaction_id = t.id
                AND sip.supplier_invoice_id = t.supplier_invoice_id
           )
         )
       )
     );
  GET DIAGNOSTICS v_released_count = ROW_COUNT;

  PERFORM set_config(
    'gnubok.supplier_payment_reversal',
    p_original_journal_entry_id::text || ':' || p_storno_journal_entry_id::text,
    true
  );
  UPDATE public.supplier_invoice_payments sip
     SET reversed_at = v_reversed_at,
         reversed_by_journal_entry_id = p_storno_journal_entry_id
   WHERE sip.journal_entry_id = p_original_journal_entry_id
     AND sip.reversed_at IS NULL;
  GET DIAGNOSTICS v_updated_count = ROW_COUNT;
  PERFORM set_config('gnubok.supplier_payment_reversal', '', true);
  IF v_updated_count IS DISTINCT FROM v_total_count THEN
    RAISE EXCEPTION 'supplier payment reversal did not retain every allocation'
      USING ERRCODE = '55000';
  END IF;

  v_event_publication := public.record_supplier_payment_reversal_events(
    p_company_id,
    p_original_journal_entry_id,
    p_storno_journal_entry_id
  );
  RETURN jsonb_build_object(
    'ok', true,
    'status', 'applied',
    'allocation_count', v_total_count,
    'invoice_count', v_invoice_count,
    'transaction_count', v_released_count,
    'event_publication', v_event_publication
  );
END;
$$;

COMMENT ON FUNCTION public.apply_supplier_payment_reversal(uuid, uuid, uuid) IS
  'Atomically restores supplier invoice payment state after one exact posted storno, retains allocation lineage, recovers a source-linked v1 payment only from an unambiguous 2440 debit and durable marker, and releases only owned transaction pointers.';

REVOKE ALL ON FUNCTION public.apply_supplier_payment_reversal(uuid, uuid, uuid)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.apply_supplier_payment_reversal(uuid, uuid, uuid)
  TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.block_contradictory_invoice_denorm()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'public'
AS $$
DECLARE
  conflicting_invoice_id uuid;
  conflicting_supplier_invoice_id uuid;
BEGIN
  IF NEW.invoice_id IS NOT NULL THEN
    SELECT ip.invoice_id INTO conflicting_invoice_id
    FROM public.invoice_payments ip
    WHERE ip.transaction_id = NEW.id
      AND ip.invoice_id <> NEW.invoice_id
    LIMIT 1;
    IF conflicting_invoice_id IS NOT NULL THEN
      RAISE EXCEPTION
        'transactions.invoice_id=% contradicts invoice_payments(invoice_id=%) for tx %',
        NEW.invoice_id, conflicting_invoice_id, NEW.id
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  IF NEW.supplier_invoice_id IS NOT NULL THEN
    SELECT sip.supplier_invoice_id INTO conflicting_supplier_invoice_id
    FROM public.supplier_invoice_payments sip
    WHERE sip.transaction_id = NEW.id
      AND sip.reversed_at IS NULL
      AND sip.supplier_invoice_id <> NEW.supplier_invoice_id
    LIMIT 1;
    IF conflicting_supplier_invoice_id IS NOT NULL THEN
      RAISE EXCEPTION
        'transactions.supplier_invoice_id=% contradicts supplier_invoice_payments(supplier_invoice_id=%) for tx %',
        NEW.supplier_invoice_id, conflicting_supplier_invoice_id, NEW.id
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION public.is_transaction_booked(p_transaction_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path TO 'public'
AS $$
  SELECT
    EXISTS (
      SELECT 1 FROM public.transactions t
      WHERE t.id = p_transaction_id
        AND t.journal_entry_id IS NOT NULL
    )
    OR EXISTS (
      SELECT 1 FROM public.invoice_payments ip
      WHERE ip.transaction_id = p_transaction_id
    )
    OR EXISTS (
      SELECT 1 FROM public.supplier_invoice_payments sip
      WHERE sip.transaction_id = p_transaction_id
        AND sip.reversed_at IS NULL
    )
    OR EXISTS (
      SELECT 1 FROM public.transaction_voucher_links tvl
      WHERE tvl.transaction_id = p_transaction_id
    );
$$;

COMMENT ON FUNCTION public.is_transaction_booked(uuid) IS
  'Returns true if the transaction has an active journal anchor. Soft-reversed supplier allocations are retained history, not current booking links.';

-- Physical deletion is the one supplier-payment reversal path without a
-- storno row. Keep its supplier sub-ledger restoration in the same transaction
-- as the voucher deletion. The narrow allocation-free compatibility paths
-- below require an exact source invoice, current payment pointer, and journal
-- line evidence. Retained allocations are never removed by this RPC.
CREATE OR REPLACE FUNCTION public.delete_last_voucher(
  p_company_id uuid,
  p_entry_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_entry                       record;
  v_period                      record;
  v_supplier_invoice            record;
  v_max_voucher                 integer;
  v_ref_count                   integer;
  v_caller_role                 text;
  v_snapshot                    jsonb;
  v_lines_snapshot              jsonb;
  v_is_period_ib                boolean := false;
  v_supplier_allocation_count   integer;
  v_supplier_line_count         integer;
  v_supplier_malformed_count    integer;
  v_supplier_2440_count         integer;
  v_supplier_2440_debit_count   integer;
  v_supplier_settlement_count   integer;
  v_supplier_transaction_count  integer;
  v_supplier_updated_count      integer;
  v_supplier_released_count     integer;
  v_supplier_total_debit        numeric;
  v_supplier_total_credit       numeric;
  v_supplier_payment_amount     numeric;
  v_supplier_settlement_amount  numeric;
  v_supplier_restored_paid      numeric;
  v_supplier_restored_status    text;
BEGIN
  SELECT cm.role INTO v_caller_role
  FROM public.company_members cm
  WHERE cm.company_id = p_company_id
    AND cm.user_id = auth.uid();

  IF v_caller_role IS NULL OR v_caller_role NOT IN ('owner', 'admin') THEN
    RAISE EXCEPTION 'Only company owners and admins can delete vouchers';
  END IF;

  SELECT * INTO v_entry
  FROM public.journal_entries
  WHERE id = p_entry_id
    AND company_id = p_company_id
  FOR UPDATE;

  IF v_entry IS NULL THEN
    RAISE EXCEPTION 'Journal entry not found';
  END IF;

  IF v_entry.status NOT IN ('posted', 'draft') THEN
    RAISE EXCEPTION 'Only posted or draft entries can be deleted (current status: %)', v_entry.status;
  END IF;

  SELECT jsonb_agg(to_jsonb(l)) INTO v_lines_snapshot
  FROM public.journal_entry_lines l
  WHERE l.journal_entry_id = p_entry_id;

  v_snapshot := to_jsonb(v_entry)
    || jsonb_build_object('lines', COALESCE(v_lines_snapshot, '[]'::jsonb));

  IF v_entry.status = 'draft' THEN
    PERFORM set_config('gnubok.allow_delete', 'true', true);

    UPDATE public.document_attachments
    SET journal_entry_id = NULL
    WHERE journal_entry_id = p_entry_id;

    DELETE FROM public.journal_entries WHERE id = p_entry_id;

    INSERT INTO public.audit_log (
      user_id,
      company_id,
      action,
      table_name,
      record_id,
      actor_id,
      old_state,
      description
    )
    VALUES (
      v_entry.user_id,
      p_company_id,
      'DELETE',
      'journal_entries',
      p_entry_id,
      auth.uid(),
      v_snapshot,
      'Deleted draft journal entry (delete_last_voucher RPC, caller: '
        || auth.uid() || ')'
    );

    RETURN jsonb_build_object(
      'deleted', true,
      'voucher_series', v_entry.voucher_series,
      'voucher_number', v_entry.voucher_number,
      'was_draft', true
    );
  END IF;

  SELECT * INTO v_period
  FROM public.fiscal_periods
  WHERE id = v_entry.fiscal_period_id
  FOR UPDATE;

  IF v_period.is_closed THEN
    RAISE EXCEPTION 'Cannot delete voucher in a closed fiscal period';
  END IF;

  IF v_period.locked_at IS NOT NULL THEN
    RAISE EXCEPTION 'Cannot delete voucher in a locked fiscal period';
  END IF;

  PERFORM 1 FROM public.voucher_sequences
  WHERE company_id = p_company_id
    AND fiscal_period_id = v_entry.fiscal_period_id
    AND voucher_series = v_entry.voucher_series
  FOR UPDATE;

  SELECT MAX(voucher_number) INTO v_max_voucher
  FROM public.journal_entries
  WHERE company_id = p_company_id
    AND fiscal_period_id = v_entry.fiscal_period_id
    AND voucher_series = v_entry.voucher_series
    AND status NOT IN ('cancelled', 'draft');

  IF v_entry.voucher_number != v_max_voucher THEN
    RAISE EXCEPTION
      'Kan bara radera det sista verifikatet i serien. % har nummer % men senaste är %',
      v_entry.voucher_series,
      v_entry.voucher_number,
      v_max_voucher;
  END IF;

  SELECT COUNT(*) INTO v_ref_count
  FROM public.journal_entries
  WHERE company_id = p_company_id
    AND status != 'cancelled'
    AND (reverses_id = p_entry_id OR correction_of_id = p_entry_id);

  IF v_ref_count > 0 THEN
    RAISE EXCEPTION 'Cannot delete: other entries reference this voucher (% references)',
      v_ref_count;
  END IF;

  -- Allocation rows are retained audit evidence. Lock and reject them before
  -- touching invoice or transaction state, including rows attached to manual
  -- vouchers and malformed supplier source entries.
  PERFORM sip.id
  FROM public.supplier_invoice_payments sip
  WHERE sip.journal_entry_id = p_entry_id
  ORDER BY sip.id
  FOR UPDATE;

  SELECT count(*)::integer
    INTO v_supplier_allocation_count
  FROM public.supplier_invoice_payments sip
  WHERE sip.journal_entry_id = p_entry_id;

  IF v_supplier_allocation_count > 0 THEN
    RAISE EXCEPTION
      'Cannot delete allocation-backed supplier payment voucher'
      USING ERRCODE = '55000';
  END IF;

  IF v_entry.source_type IN (
    'supplier_invoice_cash_payment',
    'supplier_invoice_paid'
  ) THEN
    IF v_entry.source_id IS NULL THEN
      RAISE EXCEPTION 'Supplier payment voucher has no source invoice'
        USING ERRCODE = '55000';
    END IF;

    SELECT
      si.id,
      si.company_id,
      si.status,
      si.paid_at,
      si.paid_amount,
      si.remaining_amount,
      si.total,
      si.due_date,
      si.currency,
      si.payment_journal_entry_id,
      si.is_credit_note
    INTO v_supplier_invoice
    FROM public.supplier_invoices si
    WHERE si.id = v_entry.source_id
    FOR UPDATE;

    IF NOT FOUND
       OR v_supplier_invoice.company_id IS DISTINCT FROM p_company_id THEN
      RAISE EXCEPTION 'Supplier payment source invoice ownership mismatch'
        USING ERRCODE = '55000';
    END IF;

    SELECT
      count(*)::integer,
      count(*) FILTER (
        WHERE jel.account_number IS NULL
           OR btrim(jel.account_number) = ''
           OR jel.debit_amount IS NULL
           OR jel.credit_amount IS NULL
           OR jel.debit_amount < 0
           OR jel.credit_amount < 0
           OR (
             (round(jel.debit_amount, 2) > 0)::integer
             + (round(jel.credit_amount, 2) > 0)::integer
           ) <> 1
      )::integer,
      count(*) FILTER (
        WHERE jel.account_number = '2440'
      )::integer,
      count(*) FILTER (
        WHERE jel.account_number = '2440'
          AND round(COALESCE(jel.debit_amount, 0), 2) > 0
          AND round(COALESCE(jel.credit_amount, 0), 2) = 0
      )::integer,
      count(*) FILTER (
        WHERE (
          (
            v_supplier_invoice.currency = 'SEK'
            AND round(COALESCE(jel.credit_amount, 0), 2)
                = round(v_supplier_invoice.total, 2)
          )
          OR jel.account_number ~ '^19[0-9]{2}$'
          OR jel.account_number IN ('2018', '2893')
        )
          AND round(COALESCE(jel.debit_amount, 0), 2) = 0
          AND round(COALESCE(jel.credit_amount, 0), 2) > 0
      )::integer,
      round(COALESCE(sum(jel.debit_amount), 0), 2),
      round(COALESCE(sum(jel.credit_amount), 0), 2),
      round(
        COALESCE(
          sum(jel.debit_amount) FILTER (
            WHERE jel.account_number = '2440'
          ),
          0
        ),
        2
      ),
      round(
        COALESCE(
          sum(jel.credit_amount) FILTER (
            WHERE (
              (
                v_supplier_invoice.currency = 'SEK'
                AND round(COALESCE(jel.credit_amount, 0), 2)
                    = round(v_supplier_invoice.total, 2)
              )
              OR jel.account_number ~ '^19[0-9]{2}$'
              OR jel.account_number IN ('2018', '2893')
            )
              AND round(COALESCE(jel.debit_amount, 0), 2) = 0
              AND round(COALESCE(jel.credit_amount, 0), 2) > 0
          ),
          0
        ),
        2
      )
    INTO
      v_supplier_line_count,
      v_supplier_malformed_count,
      v_supplier_2440_count,
      v_supplier_2440_debit_count,
      v_supplier_settlement_count,
      v_supplier_total_debit,
      v_supplier_total_credit,
      v_supplier_payment_amount,
      v_supplier_settlement_amount
    FROM public.journal_entry_lines jel
    WHERE jel.journal_entry_id = p_entry_id;

    IF v_supplier_line_count < 2
       OR v_supplier_malformed_count <> 0
       OR v_supplier_total_debit <= 0
       OR v_supplier_total_debit IS DISTINCT FROM v_supplier_total_credit
       OR v_supplier_invoice.is_credit_note IS DISTINCT FROM false
       OR round(v_supplier_invoice.total, 2) <= 0 THEN
      RAISE EXCEPTION 'Supplier payment voucher journal shape is ambiguous'
        USING ERRCODE = '55000';
    END IF;

    IF v_entry.source_type = 'supplier_invoice_cash_payment' THEN
      -- The established cash-method shape has exactly one settlement credit.
      -- A legacy 2440-clearing shape is accepted only when its one debit is the
      -- exact full invoice amount. For SEK invoices, the settlement leg must
      -- also equal the full invoice amount. Foreign-currency invoices still
      -- restore the full source invoice, while the balanced SEK lines prove
      -- the concrete settlement amount.
      IF v_supplier_2440_count > 1
         OR (
           v_supplier_2440_count = 1
           AND (
             v_supplier_2440_debit_count <> 1
             OR v_supplier_payment_amount
                IS DISTINCT FROM round(v_supplier_invoice.total, 2)
           )
         )
         OR v_supplier_settlement_count <> 1
         OR v_supplier_settlement_amount <= 0
         OR (
           v_supplier_invoice.currency = 'SEK'
           AND v_supplier_settlement_amount
               IS DISTINCT FROM round(v_supplier_invoice.total, 2)
         ) THEN
        RAISE EXCEPTION 'Supplier cash payment voucher journal shape is ambiguous'
          USING ERRCODE = '55000';
      END IF;

      IF v_supplier_invoice.payment_journal_entry_id
           IS DISTINCT FROM p_entry_id
         OR v_supplier_invoice.status IS DISTINCT FROM 'paid'
         OR round(COALESCE(v_supplier_invoice.paid_amount, 0), 2)
            IS DISTINCT FROM round(v_supplier_invoice.total, 2)
         OR round(
           COALESCE(
             v_supplier_invoice.remaining_amount,
             v_supplier_invoice.total
           ),
           2
         ) IS DISTINCT FROM 0::numeric THEN
        RAISE EXCEPTION 'Supplier cash payment invoice state conflicts with voucher'
          USING ERRCODE = '55000';
      END IF;

      IF EXISTS (
        SELECT 1
        FROM public.supplier_invoice_payments sip
        WHERE sip.supplier_invoice_id = v_supplier_invoice.id
          AND sip.reversed_at IS NULL
      ) THEN
        RAISE EXCEPTION 'Supplier cash payment invoice has conflicting active allocations'
          USING ERRCODE = '55000';
      END IF;

      v_supplier_restored_paid := 0;
    ELSE
      -- Compatibility for the v1 mark-paid ordering that could leave no
      -- allocation row. One exact 2440 debit is the payment amount.
      IF v_supplier_2440_count <> 1
         OR v_supplier_2440_debit_count <> 1
         OR v_supplier_payment_amount <= 0 THEN
        RAISE EXCEPTION 'Supplier payment voucher 2440 evidence is ambiguous'
          USING ERRCODE = '55000';
      END IF;

      IF v_supplier_invoice.payment_journal_entry_id
           IS DISTINCT FROM p_entry_id
         OR v_supplier_invoice.status NOT IN ('paid', 'partially_paid')
         OR round(COALESCE(v_supplier_invoice.paid_amount, 0), 2)
            < v_supplier_payment_amount
         OR round(COALESCE(v_supplier_invoice.paid_amount, 0), 2)
            > round(v_supplier_invoice.total, 2)
         OR round(
           COALESCE(
             v_supplier_invoice.remaining_amount,
             v_supplier_invoice.total
           ),
           2
         ) IS DISTINCT FROM round(
           v_supplier_invoice.total
             - COALESCE(v_supplier_invoice.paid_amount, 0),
           2
         )
         OR (
           v_supplier_invoice.status = 'paid'
           AND (
             round(COALESCE(v_supplier_invoice.remaining_amount, 0), 2) <> 0
             OR v_supplier_invoice.paid_at IS NULL
           )
         )
         OR (
           v_supplier_invoice.status = 'partially_paid'
           AND (
             round(COALESCE(v_supplier_invoice.paid_amount, 0), 2) <= 0
             OR round(COALESCE(v_supplier_invoice.remaining_amount, 0), 2) <= 0
             OR v_supplier_invoice.paid_at IS NOT NULL
           )
         ) THEN
        RAISE EXCEPTION 'Supplier payment invoice state conflicts with voucher'
          USING ERRCODE = '55000';
      END IF;

      v_supplier_restored_paid := round(
        v_supplier_invoice.paid_amount - v_supplier_payment_amount,
        2
      );
      IF v_supplier_restored_paid < 0 THEN
        RAISE EXCEPTION 'Supplier payment amount exceeds invoice paid state'
          USING ERRCODE = '55000';
      END IF;

      IF EXISTS (
        SELECT 1
        FROM public.supplier_invoice_payments sip
        WHERE sip.supplier_invoice_id = v_supplier_invoice.id
          AND sip.reversed_at IS NULL
          AND (
            sip.journal_entry_id IS NULL
            OR sip.amount IS NULL
            OR round(sip.amount, 2) <= 0
          )
      ) OR (
        SELECT round(COALESCE(sum(sip.amount), 0), 2)
        FROM public.supplier_invoice_payments sip
        WHERE sip.supplier_invoice_id = v_supplier_invoice.id
          AND sip.reversed_at IS NULL
      ) > v_supplier_restored_paid THEN
        RAISE EXCEPTION 'Supplier payment invoice has conflicting active allocations'
          USING ERRCODE = '55000';
      END IF;
    END IF;

    v_supplier_restored_status := CASE
      WHEN v_supplier_restored_paid > 0 THEN 'partially_paid'
      WHEN v_supplier_invoice.due_date IS NOT NULL
       AND v_supplier_invoice.due_date < current_date THEN 'overdue'
      ELSE 'approved'
    END;

    -- Only direct pointers to this voucher are eligible for release. A pointer
    -- to another invoice, tenant, or active allocation is conflicting state.
    PERFORM t.id
    FROM public.transactions t
    WHERE t.journal_entry_id = p_entry_id
    ORDER BY t.id
    FOR UPDATE;

    SELECT count(*)::integer
      INTO v_supplier_transaction_count
    FROM public.transactions t
    WHERE t.journal_entry_id = p_entry_id;

    IF EXISTS (
      SELECT 1
      FROM public.transactions t
      WHERE t.journal_entry_id = p_entry_id
        AND (
          t.company_id IS DISTINCT FROM p_company_id
          OR t.invoice_id IS NOT NULL
          OR (
            t.supplier_invoice_id IS NOT NULL
            AND t.supplier_invoice_id
                IS DISTINCT FROM v_supplier_invoice.id
          )
          OR EXISTS (
            SELECT 1
            FROM public.invoice_payments ip
            WHERE ip.transaction_id = t.id
          )
          OR EXISTS (
            SELECT 1
            FROM public.supplier_invoice_payments sip
            WHERE sip.transaction_id = t.id
              AND sip.reversed_at IS NULL
          )
        )
    ) THEN
      RAISE EXCEPTION 'Supplier payment transaction ownership conflicts with voucher'
        USING ERRCODE = '55000';
    END IF;

    UPDATE public.supplier_invoices si
    SET status = v_supplier_restored_status,
        paid_amount = v_supplier_restored_paid,
        remaining_amount = round(si.total - v_supplier_restored_paid, 2),
        paid_at = NULL,
        payment_journal_entry_id = NULL
    WHERE si.id = v_supplier_invoice.id
      AND si.company_id = p_company_id
      AND si.payment_journal_entry_id = p_entry_id;
    GET DIAGNOSTICS v_supplier_updated_count = ROW_COUNT;

    IF v_supplier_updated_count <> 1 THEN
      RAISE EXCEPTION 'Supplier payment deletion did not restore its invoice'
        USING ERRCODE = '55000';
    END IF;

    UPDATE public.transactions t
    SET journal_entry_id = NULL,
        supplier_invoice_id = NULL,
        is_business = NULL,
        category = NULL
    WHERE t.company_id = p_company_id
      AND t.journal_entry_id = p_entry_id
      AND t.invoice_id IS NULL
      AND (
        t.supplier_invoice_id IS NULL
        OR t.supplier_invoice_id = v_supplier_invoice.id
      );
    GET DIAGNOSTICS v_supplier_released_count = ROW_COUNT;

    IF v_supplier_released_count
         IS DISTINCT FROM v_supplier_transaction_count THEN
      RAISE EXCEPTION 'Supplier payment deletion did not release every owned transaction'
        USING ERRCODE = '55000';
    END IF;
  END IF;

  IF v_entry.reverses_id IS NOT NULL THEN
    PERFORM set_config('gnubok.allow_delete', 'true', true);
    UPDATE public.journal_entries
    SET status = 'posted', reversed_by_id = NULL
    WHERE id = v_entry.reverses_id
      AND company_id = p_company_id;
  END IF;

  v_is_period_ib := (v_period.opening_balance_entry_id = p_entry_id);
  IF v_is_period_ib THEN
    UPDATE public.fiscal_periods
    SET opening_balances_set = false
    WHERE id = v_entry.fiscal_period_id;

    UPDATE public.fiscal_periods
    SET opening_balance_entry_id = NULL
    WHERE id = v_entry.fiscal_period_id;
  END IF;

  UPDATE public.sie_imports
  SET opening_balance_entry_id = NULL
  WHERE opening_balance_entry_id = p_entry_id;

  PERFORM set_config('gnubok.allow_delete', 'true', true);

  UPDATE public.document_attachments
  SET journal_entry_id = NULL
  WHERE journal_entry_id = p_entry_id;

  DELETE FROM public.journal_entries WHERE id = p_entry_id;

  UPDATE public.voucher_sequences
  SET last_number = GREATEST(last_number - 1, 0)
  WHERE company_id = p_company_id
    AND fiscal_period_id = v_entry.fiscal_period_id
    AND voucher_series = v_entry.voucher_series;

  INSERT INTO public.audit_log (
    user_id,
    company_id,
    action,
    table_name,
    record_id,
    actor_id,
    old_state,
    description
  )
  VALUES (
    v_entry.user_id,
    p_company_id,
    'DELETE',
    'journal_entries',
    p_entry_id,
    auth.uid(),
    v_snapshot,
    'Deleted voucher ' || v_entry.voucher_series || v_entry.voucher_number
      || CASE WHEN v_is_period_ib THEN ' (was period IB)' ELSE '' END
      || ' (delete_last_voucher RPC, caller: ' || auth.uid() || ')'
  );

  RETURN jsonb_build_object(
    'deleted', true,
    'voucher_series', v_entry.voucher_series,
    'voucher_number', v_entry.voucher_number,
    'was_period_ib', v_is_period_ib
  );
END;
$function$;

NOTIFY pgrst, 'reload schema';
