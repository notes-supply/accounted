-- Stage receipt-hunt proposals in one deadline-bound database transaction.
-- The service-role grant and strict row validation keep this RPC narrower than
-- general pending_operations INSERT access.

CREATE OR REPLACE FUNCTION public.stage_receipt_hunt_proposals(
  p_company_id uuid,
  p_run_id text,
  p_deadline_at timestamptz,
  p_rows jsonb
)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  proposal jsonb;
  v_transaction_id uuid;
  v_document_id uuid;
  v_inbox_item_id uuid;
  v_proposal_user_id uuid;
  inserted_count integer := 0;
BEGIN
  IF auth.role() IS DISTINCT FROM 'service_role' THEN
    RAISE EXCEPTION 'stage_receipt_hunt_proposals requires service_role'
      USING ERRCODE = '42501';
  END IF;

  IF p_company_id IS NULL OR p_run_id IS NULL OR btrim(p_run_id) = '' THEN
    RAISE EXCEPTION 'Receipt-hunt company and run are required'
      USING ERRCODE = '22023';
  END IF;

  IF p_deadline_at IS NULL OR clock_timestamp() >= p_deadline_at THEN
    RAISE EXCEPTION 'Receipt-hunt staging deadline elapsed'
      USING ERRCODE = '57014';
  END IF;

  IF jsonb_typeof(p_rows) IS DISTINCT FROM 'array'
     OR jsonb_array_length(p_rows) < 1
     OR jsonb_array_length(p_rows) > 20 THEN
    RAISE EXCEPTION 'Receipt-hunt proposals must be an array of 1 to 20 rows'
      USING ERRCODE = '22023';
  END IF;

  FOR proposal IN SELECT value FROM jsonb_array_elements(p_rows)
  LOOP
    IF jsonb_typeof(proposal) IS DISTINCT FROM 'object'
       OR NOT proposal ?& ARRAY[
         'company_id', 'user_id', 'operation_type', 'title', 'params',
         'preview_data', 'actor_type', 'actor_label', 'risk_level',
         'agent_metadata'
       ]
       OR proposal - ARRAY[
         'company_id', 'user_id', 'operation_type', 'title', 'params',
         'preview_data', 'actor_type', 'actor_label', 'risk_level',
         'agent_metadata'
       ]::text[] <> '{}'::jsonb THEN
      RAISE EXCEPTION 'Malformed receipt-hunt proposal row'
        USING ERRCODE = '22023';
    END IF;

    IF proposal->>'company_id' IS DISTINCT FROM p_company_id::text
       OR proposal->>'operation_type' IS DISTINCT FROM 'attach_document_to_transaction'
       OR proposal->>'actor_type' IS DISTINCT FROM 'cron'
       OR proposal->>'actor_label' IS DISTINCT FROM 'Kvittojakten'
       OR proposal->>'risk_level' IS DISTINCT FROM 'medium'
       OR jsonb_typeof(proposal->'title') IS DISTINCT FROM 'string'
       OR btrim(proposal->>'title') = ''
       OR jsonb_typeof(proposal->'preview_data') IS DISTINCT FROM 'object' THEN
      RAISE EXCEPTION 'Receipt-hunt proposal identity is invalid'
        USING ERRCODE = '22023';
    END IF;

    IF jsonb_typeof(proposal->'params') IS DISTINCT FROM 'object'
       OR NOT (proposal->'params') ?& ARRAY['transaction_id', 'document_id']
       OR (proposal->'params') - ARRAY['transaction_id', 'document_id']::text[] <> '{}'::jsonb
       OR (proposal->'params'->>'transaction_id') !~
          '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
       OR (proposal->'params'->>'document_id') !~
          '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$' THEN
      RAISE EXCEPTION 'Receipt-hunt params are invalid'
        USING ERRCODE = '22023';
    END IF;

    IF jsonb_typeof(proposal->'agent_metadata') IS DISTINCT FROM 'object'
       OR NOT (proposal->'agent_metadata') ?& ARRAY[
         'source', 'run_id', 'inbox_item_id', 'confidence', 'match_reasons'
       ]
       OR (proposal->'agent_metadata') - ARRAY[
         'source', 'run_id', 'inbox_item_id', 'confidence', 'match_reasons'
       ]::text[] <> '{}'::jsonb
       OR proposal->'agent_metadata'->>'source' IS NULL
       OR proposal->'agent_metadata'->>'source' NOT IN ('receipt_hunt', 'receipt_hunt_mail')
       OR proposal->'agent_metadata'->>'run_id' IS DISTINCT FROM p_run_id
       OR (proposal->'agent_metadata'->>'inbox_item_id') !~
          '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
       OR jsonb_typeof(proposal->'agent_metadata'->'confidence') IS DISTINCT FROM 'number'
       OR jsonb_typeof(proposal->'agent_metadata'->'match_reasons') IS DISTINCT FROM 'array'
       OR (proposal->>'user_id') !~
          '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$' THEN
      RAISE EXCEPTION 'Receipt-hunt agent metadata is invalid'
        USING ERRCODE = '22023';
    END IF;

    v_transaction_id := (proposal->'params'->>'transaction_id')::uuid;
    v_document_id := (proposal->'params'->>'document_id')::uuid;
    v_inbox_item_id := (proposal->'agent_metadata'->>'inbox_item_id')::uuid;
    v_proposal_user_id := (proposal->>'user_id')::uuid;

    IF NOT EXISTS (
      SELECT 1
      FROM public.company_members member
      WHERE member.company_id = p_company_id
        AND member.user_id = v_proposal_user_id
    ) OR (
      NOT EXISTS (
        SELECT 1
        FROM public.pending_operations existing
        WHERE existing.company_id = p_company_id
          AND existing.operation_type = 'attach_document_to_transaction'
          AND existing.agent_metadata->>'run_id' = p_run_id
          AND existing.params = proposal->'params'
      )
      AND (
        NOT EXISTS (
          SELECT 1
          FROM public.transactions transaction_row
          WHERE transaction_row.id = v_transaction_id
            AND transaction_row.company_id = p_company_id
            AND transaction_row.journal_entry_id IS NULL
            AND transaction_row.document_id IS NULL
        ) OR NOT EXISTS (
          SELECT 1
          FROM public.document_attachments document
          JOIN public.invoice_inbox_items inbox
            ON inbox.id = v_inbox_item_id
           AND inbox.company_id = p_company_id
           AND inbox.document_id = document.id
          WHERE document.id = v_document_id
            AND document.company_id = p_company_id
            AND document.is_current_version = true
            AND document.journal_entry_id IS NULL
        )
      )
    ) THEN
      RAISE EXCEPTION 'Receipt-hunt proposal crosses company or references ineligible rows'
        USING ERRCODE = '42501';
    END IF;
  END LOOP;

  IF EXISTS (
    SELECT 1
    FROM (
      SELECT
        value->'params'->>'transaction_id' AS transaction_id,
        value->'params'->>'document_id' AS document_id
      FROM jsonb_array_elements(p_rows)
    ) rows
    GROUP BY rows.transaction_id
    HAVING count(*) > 1
  ) OR EXISTS (
    SELECT 1
    FROM (
      SELECT value->'params'->>'document_id' AS document_id
      FROM jsonb_array_elements(p_rows)
    ) rows
    GROUP BY rows.document_id
    HAVING count(*) > 1
  ) THEN
    RAISE EXCEPTION 'Receipt-hunt batch repeats a transaction or document'
      USING ERRCODE = '22023';
  END IF;

  -- Serialize all runs for one company. This closes the gap between the hunt's
  -- suppression read and insertion, while exact retries remain no-ops.
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(p_company_id::text, 0)
  );

  INSERT INTO public.pending_operations (
    company_id,
    user_id,
    operation_type,
    title,
    params,
    preview_data,
    actor_type,
    actor_label,
    risk_level,
    agent_metadata
  )
  SELECT
    p_company_id,
    (row->>'user_id')::uuid,
    'attach_document_to_transaction',
    row->>'title',
    row->'params',
    row->'preview_data',
    'cron',
    'Kvittojakten',
    'medium',
    row->'agent_metadata'
  FROM jsonb_array_elements(p_rows) AS item(row)
  WHERE NOT EXISTS (
    SELECT 1
    FROM public.pending_operations existing
    WHERE existing.company_id = p_company_id
      AND existing.operation_type = 'attach_document_to_transaction'
      AND (
        (
          existing.agent_metadata->>'run_id' = p_run_id
          AND existing.params = row->'params'
        )
        OR (
          existing.status IN ('pending', 'committing', 'committed')
          AND (
            existing.params->>'transaction_id' = row->'params'->>'transaction_id'
            OR existing.params->>'document_id' = row->'params'->>'document_id'
          )
        )
        OR (
          existing.status = 'rejected'
          AND existing.params = row->'params'
        )
      )
  );

  GET DIAGNOSTICS inserted_count = ROW_COUNT;

  IF clock_timestamp() >= p_deadline_at THEN
    RAISE EXCEPTION 'Receipt-hunt staging deadline elapsed during insert'
      USING ERRCODE = '57014';
  END IF;

  RETURN inserted_count;
END;
$$;

REVOKE ALL ON FUNCTION public.stage_receipt_hunt_proposals(uuid, text, timestamptz, jsonb)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.stage_receipt_hunt_proposals(uuid, text, timestamptz, jsonb)
  TO service_role;

NOTIFY pgrst, 'reload schema';
