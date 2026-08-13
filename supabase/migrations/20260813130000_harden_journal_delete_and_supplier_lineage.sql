-- Move post-release RPC changes out of 20260813120000 so databases that have
-- already recorded that migration and fresh replays converge on the same
-- definitions.
-- pg-test: covered-by lib/bookkeeping/__tests__/delete-last-voucher.pg.test.ts
-- pg-test: covered-by tests/pg/supplier-payment-retention.pg.test.ts

-- A caller can set a custom GUC, so gnubok.allow_delete alone is not an
-- authorization boundary. The trigger owner is the trusted migration role.
-- SECURITY DEFINER maintenance functions execute as that owner, while direct
-- authenticated SQL continues to execute as authenticated.
CREATE OR REPLACE FUNCTION public.enforce_journal_entry_immutability()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path TO 'pg_catalog', 'public'
AS $function$
DECLARE
  v_guard_owner name := pg_catalog.pg_get_userbyid(
    (
      SELECT p.proowner
      FROM pg_catalog.pg_proc p
      WHERE p.oid = 'public.enforce_journal_entry_immutability()'::pg_catalog.regprocedure
    )
  );
  v_trusted_delete_context boolean :=
    pg_catalog.current_setting('gnubok.allow_delete', true) = 'true'
    AND current_user = v_guard_owner;
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF v_trusted_delete_context THEN
      RETURN OLD;
    END IF;
    RAISE EXCEPTION 'Cannot delete journal entries (id: %, status: %). Use cancelled status instead.',
      OLD.id, OLD.status;
  END IF;

  IF OLD.status = 'draft' AND NEW.status IN ('draft', 'posted', 'cancelled') THEN
    RETURN NEW;
  END IF;

  IF OLD.status = 'posted' AND NEW.status IN ('reversed', 'cancelled') THEN
    IF NEW.status = 'reversed' THEN
      IF NEW.description != OLD.description OR NEW.entry_date != OLD.entry_date
         OR NEW.fiscal_period_id != OLD.fiscal_period_id
         OR NEW.voucher_number != OLD.voucher_number
         OR NEW.commit_method IS DISTINCT FROM OLD.commit_method
         OR NEW.rubric_version IS DISTINCT FROM OLD.rubric_version
         OR NEW.source_voucher_series IS DISTINCT FROM OLD.source_voucher_series
         OR NEW.source_voucher_number IS DISTINCT FROM OLD.source_voucher_number THEN
        RAISE EXCEPTION 'Cannot modify fields of a posted entry during reversal (id: %)', OLD.id;
      END IF;
    END IF;
    RETURN NEW;
  END IF;

  IF OLD.status = 'reversed' AND NEW.status = 'posted'
     AND v_trusted_delete_context THEN
    IF NEW.description != OLD.description OR NEW.entry_date != OLD.entry_date
       OR NEW.fiscal_period_id != OLD.fiscal_period_id
       OR NEW.voucher_number != OLD.voucher_number THEN
      RAISE EXCEPTION 'Cannot modify fields during un-reversal (id: %)', OLD.id;
    END IF;
    RETURN NEW;
  END IF;

  IF OLD.status = NEW.status
     AND OLD.status IN ('posted', 'reversed', 'cancelled')
     AND (pg_catalog.to_jsonb(NEW) - 'notes' - 'updated_at')
       = (pg_catalog.to_jsonb(OLD) - 'notes' - 'updated_at') THEN
    RETURN NEW;
  END IF;

  IF OLD.status = NEW.status
     AND OLD.status = 'posted'
     AND pg_catalog.current_setting('gnubok.allow_source_type_retag', true) = 'true'
     AND OLD.source_type IN ('manual', 'import')
     AND NEW.source_type = 'opening_balance'
     AND (pg_catalog.to_jsonb(NEW) - 'source_type' - 'updated_at')
       = (pg_catalog.to_jsonb(OLD) - 'source_type' - 'updated_at') THEN
    RETURN NEW;
  END IF;

  IF OLD.status = NEW.status
     AND OLD.status = 'posted'
     AND pg_catalog.current_setting('gnubok.allow_metadata_rattelse', true) = 'true'
     AND (pg_catalog.to_jsonb(NEW) - 'description' - 'entry_date' - 'updated_at')
       = (pg_catalog.to_jsonb(OLD) - 'description' - 'entry_date' - 'updated_at') THEN
    RETURN NEW;
  END IF;

  RAISE EXCEPTION 'Cannot modify a % journal entry (id: %). Committed entries are immutable per Bokforingslagen.',
    OLD.status, OLD.id;
END;
$function$;

ALTER FUNCTION public.enforce_journal_entry_immutability()
  OWNER TO postgres;
REVOKE ALL ON FUNCTION public.enforce_journal_entry_immutability()
  FROM PUBLIC, anon, authenticated, service_role;

-- Physical deletion is limited to entries that never entered a voucher series
-- and carry no commit evidence. Posted, reversed, and cancelled entries use
-- storno and remain retained.
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
  v_entry          record;
  v_caller_role    text;
  v_snapshot       jsonb;
  v_lines_snapshot jsonb;
BEGIN
  SELECT cm.role INTO v_caller_role
  FROM public.company_members cm
  WHERE cm.company_id = p_company_id
    AND cm.user_id = auth.uid();

  IF v_caller_role IS NULL OR v_caller_role NOT IN ('owner', 'admin') THEN
    RAISE EXCEPTION 'Only company owners and admins can delete draft vouchers';
  END IF;

  SELECT * INTO v_entry
  FROM public.journal_entries
  WHERE id = p_entry_id
    AND company_id = p_company_id
  FOR UPDATE;

  IF v_entry IS NULL THEN
    RAISE EXCEPTION 'Journal entry not found';
  END IF;

  IF v_entry.status IS DISTINCT FROM 'draft'
     OR v_entry.voucher_number IS DISTINCT FROM 0
     OR v_entry.committed_at IS NOT NULL THEN
    RAISE EXCEPTION
      'Only genuine draft journal entries can be physically deleted'
      USING ERRCODE = '55000';
  END IF;

  SELECT pg_catalog.jsonb_agg(pg_catalog.to_jsonb(l)) INTO v_lines_snapshot
  FROM public.journal_entry_lines l
  WHERE l.journal_entry_id = p_entry_id;

  v_snapshot := pg_catalog.to_jsonb(v_entry)
    || pg_catalog.jsonb_build_object(
      'lines',
      COALESCE(v_lines_snapshot, '[]'::jsonb)
    );

  PERFORM pg_catalog.set_config('gnubok.allow_delete', 'true', true);

  UPDATE public.document_attachments
  SET journal_entry_id = NULL
  WHERE journal_entry_id = p_entry_id;

  DELETE FROM public.journal_entries
  WHERE id = p_entry_id;

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

  RETURN pg_catalog.jsonb_build_object(
    'deleted', true,
    'voucher_series', v_entry.voucher_series,
    'voucher_number', v_entry.voucher_number,
    'was_draft', true
  );
END;
$function$;

ALTER FUNCTION public.delete_last_voucher(uuid, uuid)
  OWNER TO postgres;

REVOKE ALL ON FUNCTION public.delete_last_voucher(uuid, uuid)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.delete_last_voucher(uuid, uuid)
  TO authenticated, service_role;

-- A correction is a single forward chain, not a branch. Application preflight
-- catches ordinary retries, while this partial unique index closes the race
-- between two writers that both observed the same posted leaf. Draft and
-- cancelled construction artifacts remain possible so the existing cleanup
-- path can compensate a losing writer without deleting committed history.
CREATE UNIQUE INDEX IF NOT EXISTS uq_journal_entries_committed_correction_child
  ON public.journal_entries (correction_of_id)
  WHERE source_type = 'correction'
    AND correction_of_id IS NOT NULL
    AND status IN ('posted', 'reversed');

-- Keep the existing 20,000-root input contract. A lineage can emit at most
-- 20,000 rows and traverse at most 32 correction edges. The recursive term
-- includes one extra depth and the bounded result consumes one extra row so
-- both violations raise instead of returning a truncated graph.
CREATE OR REPLACE FUNCTION public.get_supplier_payment_lineage(
  p_company_id uuid,
  p_root_ids uuid[]
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path TO 'pg_catalog', 'public'
AS $function$
DECLARE
  v_max_depth constant integer := 32;
  v_max_rows constant integer := 20000;
  v_root_count integer;
  v_row_count integer;
  v_depth_exceeded boolean;
  v_rows jsonb;
BEGIN
  IF p_company_id IS NULL THEN
    RAISE EXCEPTION 'supplier payment lineage company is required'
      USING ERRCODE = '22004';
  END IF;
  IF p_root_ids IS NULL THEN
    RAISE EXCEPTION 'supplier payment lineage roots are required'
      USING ERRCODE = '22004';
  END IF;

  IF pg_catalog.cardinality(p_root_ids) > 20000 THEN
    RAISE EXCEPTION 'supplier payment lineage accepts at most 20000 roots'
      USING ERRCODE = '54000';
  END IF;
  IF pg_catalog.array_position(p_root_ids, NULL::uuid) IS NOT NULL THEN
    RAISE EXCEPTION 'supplier payment lineage roots cannot contain null'
      USING ERRCODE = '22004';
  END IF;

  WITH RECURSIVE requested_roots AS (
    SELECT DISTINCT requested.root_id
    FROM pg_catalog.unnest(p_root_ids) AS requested(root_id)
  ),
  lineage AS (
    SELECT
      requested.root_id,
      NULL::uuid AS parent_id,
      'root'::text AS edge_kind,
      entry.id,
      entry.entry_date,
      entry.status,
      entry.source_type,
      entry.correction_of_id,
      entry.reverses_id,
      entry.committed_at,
      0 AS depth,
      ARRAY[entry.id]::uuid[] AS path,
      false AS cycle
    FROM requested_roots requested
    JOIN public.journal_entries entry
      ON entry.id = requested.root_id
     AND entry.company_id = p_company_id

    UNION ALL

    SELECT
      parent.root_id,
      parent.id AS parent_id,
      CASE
        WHEN child.correction_of_id = parent.id THEN 'correction'
        ELSE 'storno'
      END AS edge_kind,
      child.id,
      child.entry_date,
      child.status,
      child.source_type,
      child.correction_of_id,
      child.reverses_id,
      child.committed_at,
      parent.depth + 1,
      parent.path || child.id,
      child.id = ANY(parent.path) AS cycle
    FROM lineage parent
    JOIN public.journal_entries child
      ON child.company_id = p_company_id
     AND parent.edge_kind <> 'storno'
     AND (
       child.correction_of_id = parent.id
       OR child.reverses_id = parent.id
     )
    WHERE NOT parent.cycle
      AND parent.depth < v_max_depth + 1
  ),
  bounded_lineage AS (
    SELECT *
    FROM lineage
    LIMIT v_max_rows + 1
  )
  SELECT
    (SELECT pg_catalog.count(*)::integer FROM requested_roots),
    pg_catalog.count(*)::integer,
    COALESCE(pg_catalog.bool_or(bounded_lineage.depth > v_max_depth), false),
    COALESCE(
      pg_catalog.jsonb_agg(
        pg_catalog.jsonb_build_object(
          'root_id', bounded_lineage.root_id,
          'parent_id', bounded_lineage.parent_id,
          'edge_kind', bounded_lineage.edge_kind,
          'id', bounded_lineage.id,
          'entry_date', bounded_lineage.entry_date,
          'status', bounded_lineage.status,
          'source_type', bounded_lineage.source_type,
          'correction_of_id', bounded_lineage.correction_of_id,
          'reverses_id', bounded_lineage.reverses_id,
          'committed_at', bounded_lineage.committed_at,
          'depth', bounded_lineage.depth,
          'path', bounded_lineage.path,
          'cycle', bounded_lineage.cycle
        )
        ORDER BY
          bounded_lineage.root_id,
          bounded_lineage.depth,
          bounded_lineage.path::text,
          bounded_lineage.edge_kind,
          bounded_lineage.id
      ),
      '[]'::jsonb
    )
  INTO v_root_count, v_row_count, v_depth_exceeded, v_rows
  FROM bounded_lineage;

  IF v_row_count > v_max_rows THEN
    RAISE EXCEPTION
      'supplier payment lineage exceeds maximum emitted row count of %',
      v_max_rows
      USING ERRCODE = '54000';
  END IF;

  IF v_depth_exceeded THEN
    RAISE EXCEPTION
      'supplier payment lineage exceeds maximum correction depth of %',
      v_max_depth
      USING ERRCODE = '54000';
  END IF;

  RETURN pg_catalog.jsonb_build_object(
    'requested_root_count', v_root_count,
    'rows', v_rows
  );
END;
$function$;

REVOKE ALL ON FUNCTION public.get_supplier_payment_lineage(uuid, uuid[])
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_supplier_payment_lineage(uuid, uuid[])
  TO authenticated, service_role;


-- The child line guard must use the same two-part trust decision as the
-- parent journal guard. SECURITY INVOKER is required so current_user remains
-- the authenticated caller for direct DML and becomes the migration owner
-- only when DML originates inside a trusted SECURITY DEFINER maintenance RPC.
CREATE OR REPLACE FUNCTION public.enforce_journal_entry_line_immutability()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path TO 'pg_catalog', 'public'
AS $function$
DECLARE
  v_status text;
  v_guard_owner name := pg_catalog.pg_get_userbyid(
    (
      SELECT p.proowner
      FROM pg_catalog.pg_proc p
      WHERE p.oid =
        'public.enforce_journal_entry_line_immutability()'::pg_catalog.regprocedure
    )
  );
  v_trusted_delete_context boolean :=
    pg_catalog.current_setting('gnubok.allow_delete', true) = 'true'
    AND current_user = v_guard_owner;
BEGIN
  IF v_trusted_delete_context THEN
    IF TG_OP = 'DELETE' THEN
      RETURN OLD;
    END IF;
    RETURN NEW;
  END IF;

  SELECT je.status
    INTO v_status
    FROM public.journal_entries je
   WHERE je.id = COALESCE(OLD.journal_entry_id, NEW.journal_entry_id);

  IF TG_OP = 'UPDATE'
     AND v_status = 'posted'
     AND pg_catalog.current_setting(
       'gnubok.allow_dimension_retag',
       true
     ) = 'true'
     AND (
       pg_catalog.to_jsonb(NEW) - 'dimensions' - 'cost_center' - 'project'
     ) = (
       pg_catalog.to_jsonb(OLD) - 'dimensions' - 'cost_center' - 'project'
     ) THEN
    RETURN NEW;
  END IF;

  IF TG_OP = 'DELETE'
     AND v_status = 'posted'
     AND pg_catalog.current_setting(
       'gnubok.allow_line_rattelse',
       true
     ) = 'true' THEN
    RETURN OLD;
  END IF;

  IF v_status = 'draft' THEN
    IF TG_OP = 'DELETE' THEN
      RETURN OLD;
    END IF;
    RETURN NEW;
  END IF;

  IF v_status = 'cancelled' THEN
    IF TG_OP = 'DELETE' THEN
      RETURN OLD;
    END IF;
    RAISE EXCEPTION 'Cannot % lines of a cancelled journal entry.', TG_OP;
  END IF;

  RAISE EXCEPTION 'Cannot % lines of a % journal entry.', TG_OP, v_status;
END;
$function$;

ALTER FUNCTION public.enforce_journal_entry_line_immutability()
  OWNER TO postgres;
REVOKE ALL ON FUNCTION public.enforce_journal_entry_line_immutability()
  FROM PUBLIC, anon, authenticated, service_role;

-- Both document UPDATE guards are SECURITY INVOKER so their current_user
-- checks observe the DML origin. The narrow supersede and correction-relink
-- GUCs retain their existing behavior; only the broad allow_delete bypass
-- additionally requires the trusted function owner.
CREATE OR REPLACE FUNCTION public.enforce_document_journal_entry_immutability()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path TO 'pg_catalog', 'public'
AS $function$
DECLARE
  v_guard_owner name := pg_catalog.pg_get_userbyid(
    (
      SELECT p.proowner
      FROM pg_catalog.pg_proc p
      WHERE p.oid =
        'public.enforce_document_journal_entry_immutability()'::pg_catalog.regprocedure
    )
  );
  v_trusted_delete_context boolean :=
    pg_catalog.current_setting('gnubok.allow_delete', true) = 'true'
    AND current_user = v_guard_owner;
BEGIN
  IF v_trusted_delete_context THEN
    RETURN NEW;
  END IF;

  IF pg_catalog.current_setting(
       'gnubok.allow_correction_relink',
       true
     ) = 'true'
     AND NEW.journal_entry_id IS NOT NULL THEN
    RETURN NEW;
  END IF;

  IF OLD.journal_entry_id IS NOT NULL
     AND NEW.journal_entry_id IS DISTINCT FROM OLD.journal_entry_id THEN
    RAISE EXCEPTION
      'BFL_DOCUMENT_IMMUTABILITY: cannot clear or change journal_entry_id on document % once set (BFL 5 kap 6 §). Reverse the journal entry first.',
      OLD.id;
  END IF;

  IF OLD.journal_entry_line_id IS NOT NULL
     AND NEW.journal_entry_line_id
       IS DISTINCT FROM OLD.journal_entry_line_id THEN
    RAISE EXCEPTION
      'BFL_DOCUMENT_IMMUTABILITY: cannot clear or change journal_entry_line_id on document % once set (BFL 5 kap 6 §).',
      OLD.id;
  END IF;

  RETURN NEW;
END;
$function$;

ALTER FUNCTION public.enforce_document_journal_entry_immutability()
  OWNER TO postgres;
REVOKE ALL ON FUNCTION public.enforce_document_journal_entry_immutability()
  FROM PUBLIC, anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION public.enforce_document_metadata_immutability()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path TO 'pg_catalog', 'public'
AS $function$
DECLARE
  v_entry_status text;
  v_allow_supersede boolean;
  v_allow_relink boolean;
  v_guard_owner name := pg_catalog.pg_get_userbyid(
    (
      SELECT p.proowner
      FROM pg_catalog.pg_proc p
      WHERE p.oid =
        'public.enforce_document_metadata_immutability()'::pg_catalog.regprocedure
    )
  );
  v_trusted_delete_context boolean :=
    pg_catalog.current_setting('gnubok.allow_delete', true) = 'true'
    AND current_user = v_guard_owner;
BEGIN
  IF v_trusted_delete_context THEN
    RETURN NEW;
  END IF;

  v_allow_supersede :=
    pg_catalog.current_setting('gnubok.allow_supersede', true) = 'true';
  v_allow_relink :=
    pg_catalog.current_setting(
      'gnubok.allow_correction_relink',
      true
    ) = 'true';

  IF OLD.journal_entry_id IS NULL THEN
    RETURN NEW;
  END IF;

  SELECT je.status
    INTO v_entry_status
    FROM public.journal_entries je
   WHERE je.id = OLD.journal_entry_id;

  IF v_entry_status IS NULL
     OR v_entry_status NOT IN ('posted', 'reversed') THEN
    RETURN NEW;
  END IF;

  IF NEW.file_name IS DISTINCT FROM OLD.file_name
     OR NEW.storage_path IS DISTINCT FROM OLD.storage_path
     OR NEW.file_size_bytes IS DISTINCT FROM OLD.file_size_bytes
     OR NEW.mime_type IS DISTINCT FROM OLD.mime_type
     OR NEW.sha256_hash IS DISTINCT FROM OLD.sha256_hash
     OR NEW.upload_source IS DISTINCT FROM OLD.upload_source
     OR NEW.digitization_date IS DISTINCT FROM OLD.digitization_date
     OR NEW.uploaded_by IS DISTINCT FROM OLD.uploaded_by
     OR NEW.version IS DISTINCT FROM OLD.version
     OR NEW.original_id IS DISTINCT FROM OLD.original_id
     OR (
       NOT v_allow_relink
       AND (
         NEW.journal_entry_id IS DISTINCT FROM OLD.journal_entry_id
         OR NEW.journal_entry_line_id
           IS DISTINCT FROM OLD.journal_entry_line_id
       )
     ) THEN
    INSERT INTO public.audit_log (
      user_id,
      company_id,
      action,
      table_name,
      record_id,
      description
    )
    VALUES (
      OLD.user_id,
      OLD.company_id,
      'SECURITY_EVENT',
      'document_attachments',
      OLD.id,
      'Blocked metadata or link modification of document linked to '
        || v_entry_status || ' entry ' || OLD.journal_entry_id
    );

    RAISE EXCEPTION
      'Cannot modify metadata or journal entry link of document linked to a % journal entry (BFL 7 kap)',
      v_entry_status;
  END IF;

  IF NOT v_allow_supersede
     AND (
       NEW.is_current_version IS DISTINCT FROM OLD.is_current_version
       OR NEW.superseded_by_id IS DISTINCT FROM OLD.superseded_by_id
     ) THEN
    INSERT INTO public.audit_log (
      user_id,
      company_id,
      action,
      table_name,
      record_id,
      description
    )
    VALUES (
      OLD.user_id,
      OLD.company_id,
      'SECURITY_EVENT',
      'document_attachments',
      OLD.id,
      'Blocked is_current_version/superseded_by_id flip without supersede GUC on document linked to '
        || v_entry_status || ' entry ' || OLD.journal_entry_id
    );

    RAISE EXCEPTION
      'Cannot modify is_current_version of document linked to a % journal entry without supersede GUC (BFL 7 kap)',
      v_entry_status;
  END IF;

  RETURN NEW;
END;
$function$;

ALTER FUNCTION public.enforce_document_metadata_immutability()
  OWNER TO postgres;
REVOKE ALL ON FUNCTION public.enforce_document_metadata_immutability()
  FROM PUBLIC, anon, authenticated, service_role;

-- This retention trigger is a second deletion fence behind the parent
-- immutability guard. Keep its allow_delete handling convergent with the same
-- trusted-owner decision rather than leaving a weaker duplicate consumer.
CREATE OR REPLACE FUNCTION public.enforce_retention_journal_entries()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path TO 'pg_catalog', 'public'
AS $function$
DECLARE
  v_retention_expires date;
  v_guard_owner name := pg_catalog.pg_get_userbyid(
    (
      SELECT p.proowner
      FROM pg_catalog.pg_proc p
      WHERE p.oid =
        'public.enforce_retention_journal_entries()'::pg_catalog.regprocedure
    )
  );
  v_trusted_delete_context boolean :=
    pg_catalog.current_setting('gnubok.allow_delete', true) = 'true'
    AND current_user = v_guard_owner;
BEGIN
  IF v_trusted_delete_context THEN
    RETURN OLD;
  END IF;

  SELECT fp.retention_expires_at
    INTO v_retention_expires
    FROM public.fiscal_periods fp
   WHERE fp.id = OLD.fiscal_period_id;

  IF v_retention_expires IS NOT NULL
     AND v_retention_expires > CURRENT_DATE THEN
    INSERT INTO public.audit_log (
      user_id,
      action,
      table_name,
      record_id,
      description
    )
    VALUES (
      OLD.user_id,
      'RETENTION_BLOCK',
      'journal_entries',
      OLD.id,
      'Attempted deletion within retention period (expires '
        || v_retention_expires || ')'
    );

    RAISE EXCEPTION
      'Cannot delete journal entry within 7-year retention period (expires %)',
      v_retention_expires;
  END IF;

  RETURN OLD;
END;
$function$;

ALTER FUNCTION public.enforce_retention_journal_entries()
  OWNER TO postgres;
REVOKE ALL ON FUNCTION public.enforce_retention_journal_entries()
  FROM PUBLIC, anon, authenticated, service_role;

-- cleanup_sandbox_user is the remaining broad-GUC maintenance path after the
-- SIE hard-delete functions are disabled. Pin it to the same trusted owner;
-- its existing service_role-only ACL and function-local search path remain.
ALTER FUNCTION public.cleanup_sandbox_user(uuid)
  OWNER TO postgres;

-- There is no row-level provenance from a completed SIE import to all journal
-- rows it created. The previous period-wide hard delete therefore cannot
-- prove a safe target, even when no committed rows are presently visible.
-- Keep the authorization and callable signatures, but fail closed before
-- changing imports, vouchers, lines, documents, pointers, dimensions,
-- sequences, or audit history.
CREATE OR REPLACE FUNCTION public.undo_sie_import(
  p_company_id uuid,
  p_import_id uuid,
  p_user_id uuid DEFAULT NULL
)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'pg_catalog', 'public'
SET statement_timeout TO '290s'
AS $function$
DECLARE
  v_fiscal_period_id uuid;
  v_caller_role text;
  v_actor uuid;
  v_committed_count integer;
BEGIN
  IF auth.role() = 'service_role' THEN
    v_actor := COALESCE(p_user_id, auth.uid());
  ELSE
    v_actor := auth.uid();
  END IF;

  SELECT cm.role
    INTO v_caller_role
    FROM public.company_members cm
   WHERE cm.company_id = p_company_id
     AND cm.user_id = v_actor;

  IF v_caller_role IS NULL
     OR v_caller_role NOT IN ('owner', 'admin') THEN
    RAISE EXCEPTION 'Only company owners and admins can undo SIE imports'
      USING ERRCODE = '42501';
  END IF;

  SELECT si.fiscal_period_id
    INTO v_fiscal_period_id
    FROM public.sie_imports si
   WHERE si.id = p_import_id
     AND si.company_id = p_company_id
     AND si.status = 'completed'
   FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION
      'Import % not found or not in completed status',
      p_import_id;
  END IF;

  SELECT pg_catalog.count(*)::integer
    INTO v_committed_count
    FROM public.journal_entries je
   WHERE je.company_id = p_company_id
     AND je.fiscal_period_id = v_fiscal_period_id
     AND je.source_type IN ('import', 'opening_balance')
     AND je.status IN ('posted', 'reversed', 'cancelled');

  IF v_committed_count > 0 THEN
    RAISE EXCEPTION
      'Cannot undo a completed SIE import with committed journal entries; use storno correction'
      USING ERRCODE = '55000';
  END IF;

  RAISE EXCEPTION
    'Cannot prove draft-only journal ownership for completed SIE import; hard-delete undo is disabled'
    USING ERRCODE = '55000';
END;
$function$;

ALTER FUNCTION public.undo_sie_import(uuid, uuid, uuid)
  OWNER TO postgres;
REVOKE ALL ON FUNCTION public.undo_sie_import(uuid, uuid, uuid)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.undo_sie_import(uuid, uuid, uuid)
  TO authenticated, service_role;

COMMENT ON FUNCTION public.undo_sie_import(uuid, uuid, uuid) IS
  'Rejects hard-delete undo for completed SIE imports because committed bookkeeping must be preserved and draft rows have no per-import lineage. Owner/admin authorization remains enforced; p_user_id is honored only for service_role callers.';

CREATE OR REPLACE FUNCTION public.replace_sie_import(
  p_company_id uuid,
  p_import_id uuid,
  p_user_id uuid DEFAULT NULL
)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'pg_catalog', 'public'
SET statement_timeout TO '290s'
AS $function$
DECLARE
  v_fiscal_period_id uuid;
  v_caller_role text;
  v_actor uuid;
  v_committed_count integer;
BEGIN
  IF auth.role() = 'service_role' THEN
    v_actor := COALESCE(p_user_id, auth.uid());
  ELSE
    v_actor := auth.uid();
  END IF;

  SELECT cm.role
    INTO v_caller_role
    FROM public.company_members cm
   WHERE cm.company_id = p_company_id
     AND cm.user_id = v_actor;

  IF v_caller_role IS NULL
     OR v_caller_role NOT IN ('owner', 'admin') THEN
    RAISE EXCEPTION 'Only company owners and admins can replace SIE imports'
      USING ERRCODE = '42501';
  END IF;

  SELECT si.fiscal_period_id
    INTO v_fiscal_period_id
    FROM public.sie_imports si
   WHERE si.id = p_import_id
     AND si.company_id = p_company_id
     AND si.status = 'completed'
   FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION
      'Import % not found or not in completed status',
      p_import_id;
  END IF;

  SELECT pg_catalog.count(*)::integer
    INTO v_committed_count
    FROM public.journal_entries je
   WHERE je.company_id = p_company_id
     AND je.fiscal_period_id = v_fiscal_period_id
     AND je.source_type IN ('import', 'opening_balance')
     AND je.status IN ('posted', 'reversed', 'cancelled');

  IF v_committed_count > 0 THEN
    RAISE EXCEPTION
      'Cannot replace a completed SIE import by deleting committed journal entries; use storno correction'
      USING ERRCODE = '55000';
  END IF;

  RAISE EXCEPTION
    'Cannot prove draft-only journal ownership for completed SIE import; hard-delete replacement is disabled'
    USING ERRCODE = '55000';
END;
$function$;

ALTER FUNCTION public.replace_sie_import(uuid, uuid, uuid)
  OWNER TO postgres;
REVOKE ALL ON FUNCTION public.replace_sie_import(uuid, uuid, uuid)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.replace_sie_import(uuid, uuid, uuid)
  TO authenticated, service_role;

COMMENT ON FUNCTION public.replace_sie_import(uuid, uuid, uuid) IS
  'Rejects hard-delete replacement for completed SIE imports because committed bookkeeping must be preserved and draft rows have no per-import lineage. Owner/admin authorization remains enforced; p_user_id is honored only for service_role callers.';

-- event_log is a cleanup-bound projection, but an existing row under either
-- durable outbox ID must agree exactly with that outbox row. Count the total
-- projection rows and the exact rows separately so a conflicting reuse of an
-- outbox ID cannot be mistaken for retention cleanup.
CREATE OR REPLACE FUNCTION public.record_supplier_payment_reversal_events(
  p_company_id uuid,
  p_original_journal_entry_id uuid,
  p_storno_journal_entry_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_original public.journal_entries%ROWTYPE;
  v_storno public.journal_entries%ROWTYPE;
  v_original_json jsonb;
  v_storno_json jsonb;
  v_user_id uuid;
  v_outbox_ids uuid[];
  v_outbox_count integer;
  v_published_count integer;
  v_event_log_total_count integer;
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
    RAISE EXCEPTION
      'cannot publish an unverified supplier payment original'
      USING ERRCODE = '55000';
  END IF;

  IF (
    SELECT pg_catalog.count(*)
      FROM public.journal_entries je
     WHERE je.company_id = p_company_id
       AND je.reverses_id = p_original_journal_entry_id
       AND je.source_type = 'storno'
       AND je.status = 'posted'
  ) <> 1 THEN
    RAISE EXCEPTION
      'supplier payment reversal event lineage is ambiguous'
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
    RAISE EXCEPTION
      'cannot publish an unverified supplier payment storno'
      USING ERRCODE = '55000';
  END IF;

  v_user_id := COALESCE(auth.uid(), v_original.user_id);
  IF v_user_id IS NULL
     OR NOT EXISTS (
       SELECT 1
         FROM auth.users u
        WHERE u.id = v_user_id
     ) THEN
    RAISE EXCEPTION
      'cannot publish supplier reversal events without a durable user';
  END IF;

  v_original_json := pg_catalog.to_jsonb(v_original)
    || pg_catalog.jsonb_build_object(
      'lines',
      COALESCE(
        (
          SELECT pg_catalog.jsonb_agg(
                   pg_catalog.to_jsonb(jel)
                   ORDER BY jel.sort_order, jel.id
                 )
            FROM public.journal_entry_lines jel
           WHERE jel.journal_entry_id = p_original_journal_entry_id
        ),
        '[]'::jsonb
      )
    );
  v_storno_json := pg_catalog.to_jsonb(v_storno)
    || pg_catalog.jsonb_build_object(
      'lines',
      COALESCE(
        (
          SELECT pg_catalog.jsonb_agg(
                   pg_catalog.to_jsonb(jel)
                   ORDER BY jel.sort_order, jel.id
                 )
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
  )
  VALUES
    (
      p_company_id,
      p_original_journal_entry_id,
      p_storno_journal_entry_id,
      'journal_entry.committed',
      v_user_id,
      pg_catalog.jsonb_build_object(
        'entry',
        v_storno_json,
        'userId',
        v_user_id,
        'companyId',
        p_company_id
      )
    ),
    (
      p_company_id,
      p_original_journal_entry_id,
      p_storno_journal_entry_id,
      'journal_entry.reversed',
      v_user_id,
      pg_catalog.jsonb_build_object(
        'originalEntry',
        v_original_json,
        'reversalEntry',
        v_storno_json,
        'userId',
        v_user_id,
        'companyId',
        p_company_id
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

  SELECT
    pg_catalog.count(*)::integer,
    pg_catalog.count(*) FILTER (
      WHERE o.published_at IS NOT NULL
    )::integer,
    pg_catalog.array_agg(o.id ORDER BY o.event_type)
  INTO v_outbox_count, v_published_count, v_outbox_ids
  FROM public.supplier_payment_reversal_event_outbox o
  WHERE o.company_id = p_company_id
    AND o.original_journal_entry_id = p_original_journal_entry_id
    AND o.reversal_journal_entry_id = p_storno_journal_entry_id;

  IF v_outbox_count <> 2
     OR COALESCE(pg_catalog.array_length(v_outbox_ids, 1), 0) <> 2 THEN
    RAISE EXCEPTION
      'supplier payment reversal event outbox is incomplete'
      USING ERRCODE = '55000';
  END IF;
  IF v_published_count NOT IN (0, 2) THEN
    RAISE EXCEPTION
      'supplier payment reversal event publication is partial'
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
    ON CONFLICT (outbox_event_id)
      WHERE outbox_event_id IS NOT NULL
      DO NOTHING;

    PERFORM 1
      FROM public.webhooks w
     WHERE w.company_id = p_company_id
       AND w.event_type IN (
         'journal_entry.committed',
         'journal_entry.reversed'
       )
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
      WHERE webhook_id IS NOT NULL
        AND outbox_event_id IS NOT NULL
      DO NOTHING;
  END IF;

  SELECT
    pg_catalog.count(*)::integer,
    pg_catalog.count(*) FILTER (
      WHERE e.company_id = o.company_id
        AND e.user_id = o.user_id
        AND e.event_type = o.event_type
        AND e.entity_id = o.reversal_journal_entry_id
        AND e.data = o.payload - 'userId' - 'companyId'
    )::integer
  INTO v_event_log_total_count, v_event_log_count
  FROM public.event_log e
  JOIN public.supplier_payment_reversal_event_outbox o
    ON o.id = e.outbox_event_id
  WHERE o.id = ANY(v_outbox_ids);

  IF NOT (
    (
      v_event_log_total_count = 0
      AND v_event_log_count = 0
    )
    OR (
      v_event_log_total_count = 2
      AND v_event_log_count = 2
    )
  ) THEN
    RAISE EXCEPTION
      'supplier reversal event_log projection integrity mismatch'
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
    RAISE EXCEPTION
      'supplier reversal webhook fanout could not be verified'
      USING ERRCODE = '55000';
  END IF;

  UPDATE public.supplier_payment_reversal_event_outbox o
     SET published_at = COALESCE(o.published_at, pg_catalog.now())
   WHERE o.id = ANY(v_outbox_ids);

  SELECT pg_catalog.count(*)::integer
    INTO v_delivery_count
    FROM public.webhook_deliveries d
   WHERE d.outbox_event_id = ANY(v_outbox_ids);

  RETURN pg_catalog.jsonb_build_object(
    'status',
    CASE
      WHEN v_published_count = 2 THEN 'already_published'
      ELSE 'published'
    END,
    'event_outbox_ids',
    pg_catalog.to_jsonb(v_outbox_ids),
    'event_log_count',
    v_event_log_count,
    'webhook_delivery_count',
    v_delivery_count
  );
END;
$function$;

ALTER FUNCTION public.record_supplier_payment_reversal_events(
  uuid,
  uuid,
  uuid
) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.record_supplier_payment_reversal_events(
  uuid,
  uuid,
  uuid
) FROM PUBLIC, anon, authenticated, service_role;
NOTIFY pgrst, 'reload schema';
