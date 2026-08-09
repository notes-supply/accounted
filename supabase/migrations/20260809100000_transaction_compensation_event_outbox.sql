-- Durable, idempotent publication for transaction categorization compensation.
-- The two logical journal events are enqueued in the same transaction as the
-- storno. Publication persists event_log rows, webhook fanout, and the outbox
-- completion marker in one transaction, so every retry can safely reconcile.

CREATE TABLE IF NOT EXISTS public.transaction_categorization_event_outbox (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  company_id uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  -- These identities are validated against locked rows by the enqueue and
  -- publish functions. Keeping them as values avoids introducing new RESTRICT
  -- edges into the existing company and user deletion lifecycle.
  transaction_id uuid NOT NULL,
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

ALTER TABLE public.transaction_categorization_event_outbox ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.transaction_categorization_event_outbox
  FROM PUBLIC, anon, authenticated;

ALTER TABLE public.event_log
  ADD COLUMN IF NOT EXISTS outbox_event_id uuid;

CREATE UNIQUE INDEX IF NOT EXISTS idx_event_log_outbox_event
  ON public.event_log (outbox_event_id)
  WHERE outbox_event_id IS NOT NULL;

ALTER TABLE public.webhook_deliveries
  ADD COLUMN IF NOT EXISTS outbox_event_id uuid;

CREATE UNIQUE INDEX IF NOT EXISTS idx_webhook_deliveries_webhook_outbox_event
  ON public.webhook_deliveries (webhook_id, outbox_event_id)
  WHERE webhook_id IS NOT NULL AND outbox_event_id IS NOT NULL;

CREATE OR REPLACE FUNCTION public.enqueue_transaction_compensation_events(
  p_company_id uuid,
  p_transaction_id uuid,
  p_original_journal_entry_id uuid,
  p_reversal_journal_entry_id uuid
)
RETURNS uuid[]
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_original public.journal_entries%ROWTYPE;
  v_reversal public.journal_entries%ROWTYPE;
  v_original_json jsonb;
  v_reversal_json jsonb;
  v_user_id uuid;
  v_outbox_ids uuid[];
  v_reversal_count integer;
BEGIN
  SELECT je.*
    INTO v_original
    FROM public.journal_entries je
   WHERE je.id = p_original_journal_entry_id
     AND je.company_id = p_company_id
     AND je.source_type = 'bank_transaction'
     AND je.source_id = p_transaction_id
     AND je.status = 'reversed'
     AND je.reversed_by_id = p_reversal_journal_entry_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Cannot enqueue events for an unverified compensation original: %',
      p_original_journal_entry_id USING ERRCODE = '55000';
  END IF;

  SELECT count(*)::integer
    INTO v_reversal_count
    FROM public.journal_entries je
   WHERE je.company_id = p_company_id
     AND je.reverses_id = p_original_journal_entry_id
     AND je.source_type = 'storno'
     AND je.status = 'posted';

  IF v_reversal_count <> 1 THEN
    RAISE EXCEPTION 'Cannot enqueue events for compensation with % posted reversals: %',
      v_reversal_count, p_original_journal_entry_id USING ERRCODE = '55000';
  END IF;

  SELECT je.*
    INTO v_reversal
    FROM public.journal_entries je
   WHERE je.id = p_reversal_journal_entry_id
     AND je.company_id = p_company_id
     AND je.reverses_id = p_original_journal_entry_id
     AND je.source_type = 'storno'
     AND je.status = 'posted';

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Cannot enqueue events for an unverified compensation reversal: %',
      p_reversal_journal_entry_id USING ERRCODE = '55000';
  END IF;

  IF NOT EXISTS (
    SELECT 1
      FROM public.transactions t
     WHERE t.id = p_transaction_id
       AND t.company_id = p_company_id
       AND t.journal_entry_id IS DISTINCT FROM p_original_journal_entry_id
  ) THEN
    RAISE EXCEPTION 'Cannot enqueue compensation events before source pointer cleanup: %',
      p_transaction_id USING ERRCODE = '55000';
  END IF;

  v_user_id := coalesce(auth.uid(), v_original.user_id);
  IF v_user_id IS NULL OR NOT EXISTS (
    SELECT 1 FROM auth.users u WHERE u.id = v_user_id
  ) THEN
    RAISE EXCEPTION 'Cannot enqueue compensation events without a durable actor';
  END IF;

  SELECT to_jsonb(v_original) || jsonb_build_object(
           'lines', coalesce(
             jsonb_agg(to_jsonb(jel) ORDER BY jel.sort_order, jel.id),
             '[]'::jsonb
           )
         )
    INTO v_original_json
    FROM public.journal_entry_lines jel
   WHERE jel.journal_entry_id = p_original_journal_entry_id;

  SELECT to_jsonb(v_reversal) || jsonb_build_object(
           'lines', coalesce(
             jsonb_agg(to_jsonb(jel) ORDER BY jel.sort_order, jel.id),
             '[]'::jsonb
           )
         )
    INTO v_reversal_json
    FROM public.journal_entry_lines jel
   WHERE jel.journal_entry_id = p_reversal_journal_entry_id;

  INSERT INTO public.transaction_categorization_event_outbox (
    company_id,
    transaction_id,
    original_journal_entry_id,
    reversal_journal_entry_id,
    event_type,
    user_id,
    payload
  ) VALUES
    (
      p_company_id,
      p_transaction_id,
      p_original_journal_entry_id,
      p_reversal_journal_entry_id,
      'journal_entry.committed',
      v_user_id,
      jsonb_build_object(
        'entry', v_reversal_json,
        'userId', v_user_id,
        'companyId', p_company_id
      )
    ),
    (
      p_company_id,
      p_transaction_id,
      p_original_journal_entry_id,
      p_reversal_journal_entry_id,
      'journal_entry.reversed',
      v_user_id,
      jsonb_build_object(
        'originalEntry', v_original_json,
        'reversalEntry', v_reversal_json,
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

  SELECT array_agg(o.id ORDER BY o.event_type)
    INTO v_outbox_ids
    FROM public.transaction_categorization_event_outbox o
   WHERE o.company_id = p_company_id
     AND o.transaction_id = p_transaction_id
     AND o.original_journal_entry_id = p_original_journal_entry_id
     AND o.reversal_journal_entry_id = p_reversal_journal_entry_id;

  IF coalesce(array_length(v_outbox_ids, 1), 0) <> 2 THEN
    RAISE EXCEPTION 'Compensation outbox identity is ambiguous for original %',
      p_original_journal_entry_id USING ERRCODE = '55000';
  END IF;

  RETURN v_outbox_ids;
END;
$$;

REVOKE ALL ON FUNCTION public.enqueue_transaction_compensation_events(
  uuid, uuid, uuid, uuid
) FROM PUBLIC, anon, authenticated, service_role;

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
  v_outbox_ids uuid[];
BEGIN
  IF v_jwt_role IN ('anon', 'authenticated') THEN
    IF NOT public.caller_can_write_company(p_company_id) THEN
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

    v_outbox_ids := public.enqueue_transaction_compensation_events(
      p_company_id,
      p_transaction_id,
      p_original_journal_entry_id,
      v_reversal_ids[1]
    );

    RETURN jsonb_build_object(
      'status', 'already_reversed',
      'original_journal_entry_id', p_original_journal_entry_id,
      'reversal_journal_entry_ids', to_jsonb(v_reversal_ids),
      'original_pointer_cleared', v_pointer_cleared,
      'event_outbox_ids', to_jsonb(v_outbox_ids)
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

  v_outbox_ids := public.enqueue_transaction_compensation_events(
    p_company_id,
    p_transaction_id,
    p_original_journal_entry_id,
    v_reversal_id
  );

  RETURN jsonb_build_object(
    'status', CASE WHEN v_existing_count = 1
      THEN 'recovered_existing_reversal'
      ELSE 'reversed'
    END,
    'original_journal_entry_id', p_original_journal_entry_id,
    'reversal_journal_entry_ids', to_jsonb(v_reversal_ids),
    'original_pointer_cleared', v_pointer_cleared,
    'event_outbox_ids', to_jsonb(v_outbox_ids)
  );
END;
$$;

REVOKE ALL ON FUNCTION public.compensate_transaction_categorization(
  uuid, uuid, uuid
) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.compensate_transaction_categorization(
  uuid, uuid, uuid
) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.publish_transaction_compensation_events(
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
  v_reversal_id uuid;
  v_outbox_ids uuid[];
  v_outbox_count integer;
  v_published_count integer;
  v_event_log_count integer;
  v_delivery_count integer;
BEGIN
  IF v_jwt_role IN ('anon', 'authenticated') THEN
    IF NOT public.caller_can_write_company(p_company_id) THEN
      RAISE EXCEPTION 'unauthorized: caller is not a member of company %', p_company_id
        USING ERRCODE = '42501';
    END IF;
  END IF;

  SELECT je.*
    INTO v_original
    FROM public.journal_entries je
   WHERE je.id = p_original_journal_entry_id
     AND je.company_id = p_company_id
     AND je.source_type = 'bank_transaction'
     AND je.source_id = p_transaction_id
     AND je.status = 'reversed'
   FOR SHARE;

  IF NOT FOUND OR v_original.reversed_by_id IS NULL THEN
    RAISE EXCEPTION 'Compensation original is not durably reversed: %',
      p_original_journal_entry_id USING ERRCODE = '55000';
  END IF;
  v_reversal_id := v_original.reversed_by_id;

  IF NOT EXISTS (
    SELECT 1
      FROM public.transactions t
     WHERE t.id = p_transaction_id
       AND t.company_id = p_company_id
       AND t.journal_entry_id IS DISTINCT FROM p_original_journal_entry_id
  ) OR (
    SELECT count(*)
      FROM public.journal_entries je
     WHERE je.company_id = p_company_id
       AND je.reverses_id = p_original_journal_entry_id
       AND je.source_type = 'storno'
       AND je.status = 'posted'
  ) <> 1 THEN
    RAISE EXCEPTION 'Compensation pair or source pointer is ambiguous for original %',
      p_original_journal_entry_id USING ERRCODE = '55000';
  END IF;

  PERFORM 1
    FROM public.transaction_categorization_event_outbox o
   WHERE o.company_id = p_company_id
     AND o.transaction_id = p_transaction_id
     AND o.original_journal_entry_id = p_original_journal_entry_id
     AND o.reversal_journal_entry_id = v_reversal_id
   ORDER BY o.event_type
   FOR UPDATE;

  SELECT
    count(*)::integer,
    count(*) FILTER (WHERE o.published_at IS NOT NULL)::integer,
    array_agg(o.id ORDER BY o.event_type)
    INTO v_outbox_count, v_published_count, v_outbox_ids
    FROM public.transaction_categorization_event_outbox o
   WHERE o.company_id = p_company_id
     AND o.transaction_id = p_transaction_id
     AND o.original_journal_entry_id = p_original_journal_entry_id
     AND o.reversal_journal_entry_id = v_reversal_id
     AND o.event_type IN ('journal_entry.committed', 'journal_entry.reversed');

  IF v_outbox_count <> 2 OR coalesce(array_length(v_outbox_ids, 1), 0) <> 2 THEN
    RAISE EXCEPTION 'Compensation outbox is incomplete or ambiguous for original %',
      p_original_journal_entry_id USING ERRCODE = '55000';
  END IF;

  IF v_published_count NOT IN (0, 2) THEN
    RAISE EXCEPTION 'Compensation outbox has a partial publication marker for original %',
      p_original_journal_entry_id USING ERRCODE = '55000';
  END IF;

  IF v_published_count = 2 THEN
    SELECT count(*)::integer
      INTO v_event_log_count
      FROM public.event_log e
     WHERE e.outbox_event_id = ANY(v_outbox_ids);

    SELECT count(*)::integer
      INTO v_delivery_count
      FROM public.webhook_deliveries d
     WHERE d.outbox_event_id = ANY(v_outbox_ids);

    RETURN jsonb_build_object(
      'status', 'already_published',
      'original_journal_entry_id', p_original_journal_entry_id,
      'reversal_journal_entry_id', v_reversal_id,
      'event_outbox_ids', to_jsonb(v_outbox_ids),
      'event_log_count', v_event_log_count,
      'webhook_delivery_count', v_delivery_count
    );
  END IF;

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
  FROM public.transaction_categorization_event_outbox o
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
    'txcomp_' || o.id::text,
    o.id
  FROM public.transaction_categorization_event_outbox o
  JOIN public.webhooks w
    ON w.company_id = o.company_id
   AND w.event_type = o.event_type
   AND w.active = true
   AND w.disabled_at IS NULL
  WHERE o.id = ANY(v_outbox_ids)
  ON CONFLICT (webhook_id, outbox_event_id)
    WHERE webhook_id IS NOT NULL AND outbox_event_id IS NOT NULL
    DO NOTHING;

  SELECT count(*)::integer
    INTO v_event_log_count
    FROM public.event_log e
    JOIN public.transaction_categorization_event_outbox o
      ON o.id = e.outbox_event_id
   WHERE o.id = ANY(v_outbox_ids)
     AND e.company_id = o.company_id
     AND e.user_id = o.user_id
     AND e.event_type = o.event_type
     AND e.entity_id = o.reversal_journal_entry_id
     AND e.data = o.payload - 'userId' - 'companyId';

  IF v_event_log_count <> 2 THEN
    RAISE EXCEPTION 'Compensation event_log persistence could not be verified for original %',
      p_original_journal_entry_id USING ERRCODE = '55000';
  END IF;

  IF EXISTS (
    SELECT 1
      FROM public.webhooks w
      JOIN public.transaction_categorization_event_outbox o
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
    RAISE EXCEPTION 'Compensation webhook fanout could not be verified for original %',
      p_original_journal_entry_id USING ERRCODE = '55000';
  END IF;

  UPDATE public.transaction_categorization_event_outbox o
     SET published_at = now()
   WHERE o.id = ANY(v_outbox_ids)
     AND o.published_at IS NULL;

  SELECT count(*)::integer
    INTO v_delivery_count
    FROM public.webhook_deliveries d
   WHERE d.outbox_event_id = ANY(v_outbox_ids);

  RETURN jsonb_build_object(
    'status', 'published',
    'original_journal_entry_id', p_original_journal_entry_id,
    'reversal_journal_entry_id', v_reversal_id,
    'event_outbox_ids', to_jsonb(v_outbox_ids),
    'event_log_count', v_event_log_count,
    'webhook_delivery_count', v_delivery_count
  );
END;
$$;

REVOKE ALL ON FUNCTION public.publish_transaction_compensation_events(
  uuid, uuid, uuid
) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.publish_transaction_compensation_events(
  uuid, uuid, uuid
) TO authenticated, service_role;

COMMENT ON TABLE public.transaction_categorization_event_outbox IS
  'Durable logical journal events created atomically with transaction categorization storno.';

COMMENT ON FUNCTION public.publish_transaction_compensation_events(uuid, uuid, uuid) IS
  'Idempotently persists compensation events and active webhook deliveries, then marks their outbox rows published in the same transaction.';

NOTIFY pgrst, 'reload schema';
