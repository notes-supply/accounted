-- WP5 M5 durable transaction categorization compensation.
-- Symbolic draft: allocate a numeric migration version only at candidate freeze.
-- Depends on M2 and M4.

CREATE TABLE public.transaction_categorization_compensations (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  company_id uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  transaction_id uuid NOT NULL REFERENCES public.transactions(id) ON DELETE RESTRICT,
  root_journal_entry_id uuid NOT NULL REFERENCES public.journal_entries(id) ON DELETE RESTRICT,
  original_journal_entry_id uuid NOT NULL REFERENCES public.journal_entries(id) ON DELETE RESTRICT,
  reversal_journal_entry_id uuid NOT NULL REFERENCES public.journal_entries(id) ON DELETE RESTRICT,
  publication_user_id uuid NOT NULL,
  actor_type text NOT NULL,
  actor_id uuid,
  actor_label text,
  committed_publication_id uuid REFERENCES public.accounting_publications(id) ON DELETE RESTRICT,
  reversed_publication_id uuid REFERENCES public.accounting_publications(id) ON DELETE RESTRICT,
  applied_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT categorization_compensation_actor_type CHECK (
    actor_type IN ('user', 'api_key', 'mcp_oauth', 'cron', 'system', 'agent_chat')
  ),
  CONSTRAINT categorization_compensation_original_unique
    UNIQUE (company_id, original_journal_entry_id),
  CONSTRAINT categorization_compensation_transaction_original_unique
    UNIQUE (company_id, transaction_id, original_journal_entry_id),
  CONSTRAINT categorization_compensation_reversal_unique
    UNIQUE (reversal_journal_entry_id),
  CONSTRAINT categorization_compensation_publications_pair CHECK (
    (committed_publication_id IS NULL AND reversed_publication_id IS NULL)
    OR (committed_publication_id IS NOT NULL AND reversed_publication_id IS NOT NULL)
  )
);

ALTER TABLE public.transaction_categorization_compensations ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.transaction_categorization_compensations
  FROM PUBLIC, anon, authenticated, service_role;

COMMENT ON TABLE public.transaction_categorization_compensations IS
  'Durable identity for one atomic bank categorization storno and its two M2 publications.';

CREATE OR REPLACE FUNCTION public.resolve_categorization_compensation_actor(
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
  IF v_role = 'authenticated' THEN
    v_actor_id := auth.uid();
    IF v_actor_id IS NULL
       OR public.current_active_company_id() IS DISTINCT FROM p_company_id
       OR NOT public.current_user_can_write()
       OR NOT public.caller_is_company_member(p_company_id) THEN
      RAISE EXCEPTION 'Unauthorized categorization compensation for company %', p_company_id
        USING ERRCODE = '42501';
    END IF;
    v_actor_type := 'user';
    v_actor_label := NULL;
  ELSIF v_role = 'service_role' THEN
    IF p_actor_type NOT IN ('user', 'api_key', 'mcp_oauth', 'cron', 'system', 'agent_chat') THEN
      RAISE EXCEPTION 'Service categorization compensation requires a verified actor type'
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
    RAISE EXCEPTION 'Categorization compensation requires authenticated or service_role claims'
      USING ERRCODE = '42501';
  END IF;

  RETURN jsonb_build_object(
    'actor_type', v_actor_type,
    'actor_id', v_actor_id,
    'actor_label', v_actor_label
  );
END;
$function$;

REVOKE ALL ON FUNCTION public.resolve_categorization_compensation_actor(uuid, text, uuid, text)
  FROM PUBLIC, anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION public.categorization_reversal_lines_match(
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
      SELECT 1
      FROM public.journal_entry_lines line
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

REVOKE ALL ON FUNCTION public.categorization_reversal_lines_match(uuid, uuid)
  FROM PUBLIC, anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION public.serialize_categorization_lineage_correction()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'pg_catalog', 'public'
AS $function$
DECLARE
  v_root_id uuid;
BEGIN
  IF NEW.source_type IS DISTINCT FROM 'correction'
     OR NEW.status NOT IN ('posted', 'reversed')
     OR NEW.correction_of_id IS NULL THEN
    RETURN NEW;
  END IF;

  WITH RECURSIVE ancestry AS (
    SELECT entry.id, entry.correction_of_id, ARRAY[NEW.id, entry.id]::uuid[] AS path
    FROM public.journal_entries entry
    WHERE entry.id = NEW.correction_of_id

    UNION ALL

    SELECT parent.id, parent.correction_of_id, ancestry.path || parent.id
    FROM ancestry
    JOIN public.journal_entries parent ON parent.id = ancestry.correction_of_id
    WHERE ancestry.correction_of_id IS NOT NULL
      AND NOT parent.id = ANY(ancestry.path)
      AND cardinality(ancestry.path) <= 34
  )
  SELECT (array_agg(id ORDER BY cardinality(path) DESC)
          FILTER (WHERE correction_of_id IS NULL))[1]
  INTO v_root_id
  FROM ancestry;

  IF v_root_id IS NULL THEN
    RETURN NEW;
  END IF;

  PERFORM entry.id
  FROM public.journal_entries entry
  WHERE entry.id = v_root_id
  FOR UPDATE;

  IF EXISTS (
    SELECT 1
    FROM public.transaction_categorization_compensations command
    WHERE command.company_id = NEW.company_id
      AND command.root_journal_entry_id = v_root_id
  ) THEN
    RAISE EXCEPTION 'Cannot commit a correction after categorization compensation'
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END;
$function$;

CREATE TRIGGER b_serialize_categorization_lineage_correction
  BEFORE INSERT OR UPDATE OF status, correction_of_id, source_type
  ON public.journal_entries
  FOR EACH ROW EXECUTE FUNCTION public.serialize_categorization_lineage_correction();

REVOKE ALL ON FUNCTION public.serialize_categorization_lineage_correction()
  FROM PUBLIC, anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION public.compensate_transaction_categorization(
  p_company_id uuid,
  p_transaction_id uuid,
  p_original_journal_entry_id uuid,
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
  v_transaction_pointer uuid;
  v_original public.journal_entries%ROWTYPE;
  v_reversal public.journal_entries%ROWTYPE;
  v_command public.transaction_categorization_compensations%ROWTYPE;
  v_lineage jsonb;
  v_reversal_id uuid;
  v_existing_reversal_id uuid;
  v_existing_count integer;
  v_voucher_number integer;
  v_committed_key text;
  v_reversed_key text;
  v_committed_payload jsonb;
  v_reversed_payload jsonb;
  v_committed_publication jsonb;
  v_reversed_publication jsonb;
BEGIN
  IF p_company_id IS NULL OR p_transaction_id IS NULL
     OR p_original_journal_entry_id IS NULL THEN
    RAISE EXCEPTION 'Categorization compensation identity is required'
      USING ERRCODE = '22004';
  END IF;

  v_actor := public.resolve_categorization_compensation_actor(
    p_company_id, p_actor_type, p_actor_id, p_actor_label
  );
  v_actor_type := v_actor ->> 'actor_type';
  v_actor_id := NULLIF(v_actor ->> 'actor_id', '')::uuid;
  v_actor_label := NULLIF(v_actor ->> 'actor_label', '');

  -- Stable lock order: transaction, original journal, reversal journal,
  -- durable command. M4 locks the transaction before the journal as well.
  SELECT transaction_row.journal_entry_id
  INTO v_transaction_pointer
  FROM public.transactions transaction_row
  WHERE transaction_row.id = p_transaction_id
    AND transaction_row.company_id = p_company_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Categorized transaction not found: %', p_transaction_id
      USING ERRCODE = 'P0002';
  END IF;

  SELECT * INTO v_original
  FROM public.journal_entries entry
  WHERE entry.id = p_original_journal_entry_id
    AND entry.company_id = p_company_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Original categorization journal entry not found: %', p_original_journal_entry_id
      USING ERRCODE = 'P0002';
  END IF;

  IF v_original.source_type IS DISTINCT FROM 'bank_transaction'
     OR v_original.source_id IS DISTINCT FROM p_transaction_id
     OR v_original.categorization_category IS NULL
     OR v_original.categorization_is_business IS NULL THEN
    RAISE EXCEPTION 'Journal entry is not the exact staged transaction categorization'
      USING ERRCODE = '22023';
  END IF;

  v_publication_user_id := v_original.user_id;
  IF v_publication_user_id IS NULL OR NOT EXISTS (
    SELECT 1
    FROM public.company_members member
    WHERE member.company_id = p_company_id
      AND member.user_id = v_publication_user_id
  ) THEN
    RAISE EXCEPTION 'Categorization publication principal is not a current company member'
      USING ERRCODE = '42501';
  END IF;

  v_lineage := public.get_journal_lineage(
    p_company_id, ARRAY[p_original_journal_entry_id]
  );
  IF v_lineage ->> 'valid' IS DISTINCT FROM 'true'
     OR jsonb_typeof(v_lineage -> 'rows') IS DISTINCT FROM 'array'
     OR NOT EXISTS (
       SELECT 1
       FROM jsonb_array_elements(v_lineage -> 'rows') node
       WHERE (node ->> 'id')::uuid = p_original_journal_entry_id
         AND node ->> 'edge_kind' = 'root'
         AND (node ->> 'depth')::integer = 0
     )
     OR EXISTS (
       SELECT 1
       FROM jsonb_array_elements(v_lineage -> 'rows') node
       WHERE node ->> 'edge_kind' = 'correction'
     ) THEN
    RAISE EXCEPTION 'Categorization compensation has contradictory shared lineage'
      USING ERRCODE = '23514';
  END IF;

  SELECT count(*)::integer, (array_agg(entry.id ORDER BY entry.id))[1]
  INTO v_existing_count, v_existing_reversal_id
  FROM public.journal_entries entry
  WHERE entry.company_id = p_company_id
    AND entry.reverses_id = p_original_journal_entry_id
    AND entry.source_type = 'storno'
    AND entry.status IN ('posted', 'reversed');

  IF v_existing_count > 1 THEN
    RETURN jsonb_build_object(
      'status', 'conflict',
      'reason', 'multiple categorization storno entries exist',
      'company_id', p_company_id,
      'transaction_id', p_transaction_id,
      'root_journal_entry_id', p_original_journal_entry_id,
      'original_journal_entry_id', p_original_journal_entry_id,
      'reversal_journal_entry_id', NULL
    );
  END IF;

  SELECT * INTO v_command
  FROM public.transaction_categorization_compensations command
  WHERE command.company_id = p_company_id
    AND command.original_journal_entry_id = p_original_journal_entry_id
  FOR UPDATE;

  IF FOUND THEN
    IF v_command.transaction_id IS DISTINCT FROM p_transaction_id
       OR v_command.root_journal_entry_id IS DISTINCT FROM p_original_journal_entry_id
       OR v_command.publication_user_id IS DISTINCT FROM v_publication_user_id
       OR v_command.actor_type IS DISTINCT FROM v_actor_type
       OR v_command.actor_id IS DISTINCT FROM v_actor_id
       OR v_command.actor_label IS DISTINCT FROM v_actor_label
       OR v_existing_count IS DISTINCT FROM 1
       OR v_existing_reversal_id IS DISTINCT FROM v_command.reversal_journal_entry_id
       OR v_original.status IS DISTINCT FROM 'reversed'
       OR v_original.reversed_by_id IS DISTINCT FROM v_command.reversal_journal_entry_id THEN
      RETURN jsonb_build_object(
        'status', 'conflict',
        'reason', 'stored categorization compensation identity differs',
        'company_id', p_company_id,
        'transaction_id', p_transaction_id,
        'root_journal_entry_id', p_original_journal_entry_id,
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
       OR v_reversal.reverses_id IS DISTINCT FROM p_original_journal_entry_id
       OR NOT public.categorization_reversal_lines_match(
         p_original_journal_entry_id, v_reversal.id
       )
       OR v_transaction_pointer IS NOT NULL THEN
      RAISE EXCEPTION 'Stored categorization compensation is incomplete or contradictory'
        USING ERRCODE = '55000';
    END IF;

    v_committed_key := 'journal:' || v_reversal.id::text || ':committed';
    v_reversed_key := 'journal:' || p_original_journal_entry_id::text || ':reversed';
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
        p_company_id, p_original_journal_entry_id
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
      p_company_id, v_reversed_key, 'journal_entry.reversed',
      v_reversal.id, v_command.publication_user_id, v_reversed_payload
    );

    IF (v_committed_publication ->> 'publication_id')::uuid IS DISTINCT FROM v_command.committed_publication_id
       OR (v_reversed_publication ->> 'publication_id')::uuid IS DISTINCT FROM v_command.reversed_publication_id THEN
      RAISE EXCEPTION 'Stored categorization publication identity is contradictory'
        USING ERRCODE = '55000';
    END IF;

    RETURN jsonb_build_object(
      'status', 'already_applied',
      'company_id', p_company_id,
      'transaction_id', p_transaction_id,
      'root_journal_entry_id', p_original_journal_entry_id,
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

  IF v_transaction_pointer IS DISTINCT FROM p_original_journal_entry_id THEN
    RETURN jsonb_build_object(
      'status', 'conflict',
      'reason', 'transaction no longer points to the staged categorization',
      'company_id', p_company_id,
      'transaction_id', p_transaction_id,
      'root_journal_entry_id', p_original_journal_entry_id,
      'original_journal_entry_id', p_original_journal_entry_id,
      'reversal_journal_entry_id', NULL
    );
  END IF;

  IF v_original.status = 'reversed' THEN
    IF v_existing_count <> 1
       OR v_original.reversed_by_id IS DISTINCT FROM v_existing_reversal_id THEN
      RETURN jsonb_build_object(
        'status', 'conflict',
        'reason', 'reversed categorization lacks one exact storno',
        'company_id', p_company_id,
        'transaction_id', p_transaction_id,
        'root_journal_entry_id', p_original_journal_entry_id,
        'original_journal_entry_id', p_original_journal_entry_id,
        'reversal_journal_entry_id', v_original.reversed_by_id
      );
    END IF;
    v_reversal_id := v_existing_reversal_id;
    SELECT * INTO v_reversal
    FROM public.journal_entries entry
    WHERE entry.id = v_reversal_id
      AND entry.company_id = p_company_id
      AND entry.status = 'posted'
      AND entry.source_type = 'storno'
    FOR UPDATE;
    IF NOT FOUND OR NOT public.categorization_reversal_lines_match(
      p_original_journal_entry_id, v_reversal_id
    ) THEN
      RETURN jsonb_build_object(
        'status', 'conflict',
        'reason', 'recorded categorization storno does not exactly reverse the original',
        'company_id', p_company_id,
        'transaction_id', p_transaction_id,
        'root_journal_entry_id', p_original_journal_entry_id,
        'original_journal_entry_id', p_original_journal_entry_id,
        'reversal_journal_entry_id', v_reversal_id
      );
    END IF;
  ELSIF v_original.status = 'posted' THEN
    IF v_existing_count <> 0 OR v_original.reversed_by_id IS NOT NULL THEN
      RETURN jsonb_build_object(
        'status', 'conflict',
        'reason', 'posted categorization already has contradictory storno evidence',
        'company_id', p_company_id,
        'transaction_id', p_transaction_id,
        'root_journal_entry_id', p_original_journal_entry_id,
        'original_journal_entry_id', p_original_journal_entry_id,
        'reversal_journal_entry_id', v_original.reversed_by_id
      );
    END IF;

    INSERT INTO public.journal_entries (
      company_id, user_id, fiscal_period_id, voucher_number, voucher_series,
      entry_date, description, source_type, source_id, reverses_id, status
    ) VALUES (
      p_company_id, v_publication_user_id, v_original.fiscal_period_id, 0,
      COALESCE(v_original.voucher_series, 'A'), v_original.entry_date,
      'Makulering: ' || v_original.description, 'storno',
      v_original.source_id, p_original_journal_entry_id, 'draft'
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
    WHERE line.journal_entry_id = p_original_journal_entry_id
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
    WHERE entry.id = p_original_journal_entry_id
      AND entry.company_id = p_company_id
      AND entry.status = 'posted';
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Original categorization changed during compensation'
        USING ERRCODE = '40001';
    END IF;

    SELECT * INTO v_reversal
    FROM public.journal_entries entry
    WHERE entry.id = v_reversal_id
      AND entry.company_id = p_company_id;
  ELSE
    RAISE EXCEPTION 'Categorization entry is not posted or exactly reversed'
      USING ERRCODE = '55000';
  END IF;

  PERFORM accounting_private.grant_accounting_command_capability(
    'transaction_categorization_clear', p_company_id, p_transaction_id
  );
  UPDATE public.transactions transaction_row
  SET journal_entry_id = NULL
  WHERE transaction_row.id = p_transaction_id
    AND transaction_row.company_id = p_company_id
    AND transaction_row.journal_entry_id = p_original_journal_entry_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Categorization pointer changed during compensation'
      USING ERRCODE = '40001';
  END IF;
  PERFORM accounting_private.revoke_accounting_command_capability(
    'transaction_categorization_clear', p_company_id, p_transaction_id
  );

  INSERT INTO public.transaction_categorization_compensations (
    company_id, transaction_id, root_journal_entry_id,
    original_journal_entry_id, reversal_journal_entry_id,
    publication_user_id, actor_type, actor_id, actor_label
  ) VALUES (
    p_company_id, p_transaction_id, p_original_journal_entry_id,
    p_original_journal_entry_id, v_reversal_id, v_publication_user_id,
    v_actor_type, v_actor_id, v_actor_label
  ) RETURNING * INTO v_command;

  PERFORM set_config('gnubok.actor_type', v_actor_type, true);
  PERFORM set_config('gnubok.actor_label', COALESCE(v_actor_label, ''), true);

  v_committed_key := 'journal:' || v_reversal.id::text || ':committed';
  v_reversed_key := 'journal:' || p_original_journal_entry_id::text || ':reversed';
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
      p_company_id, p_original_journal_entry_id
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
    p_company_id, v_reversed_key, 'journal_entry.reversed',
    v_reversal.id, v_publication_user_id, v_reversed_payload
  );

  UPDATE public.transaction_categorization_compensations command
  SET committed_publication_id = (v_committed_publication ->> 'publication_id')::uuid,
      reversed_publication_id = (v_reversed_publication ->> 'publication_id')::uuid
  WHERE command.id = v_command.id
    AND command.committed_publication_id IS NULL
    AND command.reversed_publication_id IS NULL;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Categorization durable publication marker was not stored'
      USING ERRCODE = '55000';
  END IF;

  INSERT INTO public.audit_log (
    user_id, company_id, action, table_name, record_id, actor_id,
    old_state, new_state, description, actor_type, actor_label
  ) VALUES (
    v_publication_user_id, p_company_id, 'REVERSE',
    'transactions', p_transaction_id, v_actor_id,
    jsonb_build_object('journal_entry_id', p_original_journal_entry_id),
    jsonb_build_object('journal_entry_id', NULL, 'reversal_journal_entry_id', v_reversal_id),
    'Atomically compensated a transaction categorization voucher',
    v_actor_type, v_actor_label
  );

  RETURN jsonb_build_object(
    'status', 'applied',
    'company_id', p_company_id,
    'transaction_id', p_transaction_id,
    'root_journal_entry_id', p_original_journal_entry_id,
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

REVOKE ALL ON FUNCTION public.compensate_transaction_categorization(
  uuid, uuid, uuid, text, uuid, text
) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.compensate_transaction_categorization(
  uuid, uuid, uuid, text, uuid, text
) TO authenticated, service_role;

COMMENT ON FUNCTION public.compensate_transaction_categorization(
  uuid, uuid, uuid, text, uuid, text
) IS 'Atomically stornoes one exact staged bank-transaction voucher, clears only its own pointer, records durable publications, and returns stable recovery identity.';

NOTIFY pgrst, 'reload schema';
