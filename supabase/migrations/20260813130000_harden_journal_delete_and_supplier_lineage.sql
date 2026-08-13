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
     AND entry.status IN ('posted', 'reversed')

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
     AND child.status IN ('posted', 'reversed')
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
-- Retained allocations stay attached to their original payment root even when
-- the live correction descendant is cancelled. Re-publish the trigger so its
-- storno-pointer guard proves that exact immutable ancestry instead of requiring
-- every sanctioned storno to reverse the root directly.
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
  v_current record;
  v_current_id uuid;
  v_ancestry_ids uuid[] := ARRAY[]::uuid[];
  v_ancestry_depth integer := 0;
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
     OR v_reversal.reverses_id IS NULL THEN
    RAISE EXCEPTION 'supplier invoice payment reversal must reference the exact posted storno'
      USING ERRCODE = '23514';
  END IF;

  -- A plain cancellation directly reverses the allocation-bearing root. A
  -- sanctioned correction cancellation reverses the live correction leaf while
  -- the immutable allocation remains attached to its original root. Walk that
  -- committed correction ancestry backwards and require it to terminate at the
  -- exact allocation root; missing, cross-company, cyclic, non-correction, live,
  -- or over-deep intermediates remain invalid. The SECURITY DEFINER RPC performs
  -- the broader state and sibling checks before setting the trusted GUC; this
  -- trigger independently protects the retained root/storno pointer invariant.
  v_current_id := v_reversal.reverses_id;
  LOOP
    IF v_current_id = ANY(v_ancestry_ids) THEN
      RAISE EXCEPTION 'supplier invoice payment reversal correction ancestry is cyclic'
        USING ERRCODE = '23514';
    END IF;
    IF v_ancestry_depth > 32 THEN
      RAISE EXCEPTION 'supplier invoice payment reversal correction ancestry exceeds maximum depth'
        USING ERRCODE = '54000';
    END IF;

    SELECT je.company_id, je.status, je.source_type, je.correction_of_id
      INTO v_current
      FROM public.journal_entries je
     WHERE je.id = v_current_id
     FOR SHARE;
    IF NOT FOUND OR v_current.company_id IS DISTINCT FROM OLD.company_id THEN
      RAISE EXCEPTION 'supplier invoice payment reversal correction ancestry is missing or cross-company'
        USING ERRCODE = '23514';
    END IF;
    IF v_current.status IS DISTINCT FROM 'reversed' THEN
      RAISE EXCEPTION 'supplier invoice payment reversal correction ancestry contains a non-reversed entry'
        USING ERRCODE = '23514';
    END IF;

    IF v_current_id = OLD.journal_entry_id THEN
      EXIT;
    END IF;
    IF v_current.source_type IS DISTINCT FROM 'correction'
       OR v_current.correction_of_id IS NULL THEN
      RAISE EXCEPTION 'supplier invoice payment reversal must reference the exact posted storno'
        USING ERRCODE = '23514';
    END IF;

    v_ancestry_ids := pg_catalog.array_append(v_ancestry_ids, v_current_id);
    v_current_id := v_current.correction_of_id;
    v_ancestry_depth := v_ancestry_depth + 1;
  END LOOP;

  -- The linked storno is freshly posted and normally has committed_at. Keep the
  -- fallback for the same legacy nullable-commit boundary as journal lineage.
  NEW.reversed_at := COALESCE(v_reversal.committed_at, now());
  RETURN NEW;
END;
$$;


ALTER FUNCTION public.enforce_supplier_invoice_payment_retention()
  OWNER TO postgres;

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
  v_root record;
  v_current record;
  v_storno record;
  v_invoice record;
  v_legacy_invoice record;
  v_v1_invoice record;
  v_role text := COALESCE(auth.role(), '');
  v_ancestry_ids uuid[] := ARRAY[]::uuid[];
  v_current_id uuid := p_original_journal_entry_id;
  v_root_journal_entry_id uuid;
  v_expected_child_id uuid;
  v_ancestry_index integer;
  v_ancestry_depth integer := 0;
  v_live_child_count integer;
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

  -- Resolve the requested cancellation backwards to one exact root before
  -- taking the root-scoped advisory lock. Committed journal lineage is
  -- immutable, but every row is revalidated after locking. The bounded walk
  -- fails closed on cycles, missing/cross-company parents, and malformed roots.
  LOOP
    IF v_current_id = ANY(v_ancestry_ids) THEN
      RAISE EXCEPTION 'supplier payment correction ancestry is cyclic'
        USING ERRCODE = '55000';
    END IF;
    IF v_ancestry_depth > 32 THEN
      RAISE EXCEPTION 'supplier payment correction ancestry exceeds maximum depth'
        USING ERRCODE = '54000';
    END IF;

    SELECT je.company_id, je.status, je.source_type, je.source_id,
           je.reversed_by_id, je.correction_of_id
      INTO v_current
      FROM public.journal_entries je
     WHERE je.id = v_current_id;
    IF NOT FOUND
       OR v_current.company_id IS DISTINCT FROM p_company_id THEN
      RAISE EXCEPTION 'supplier payment correction ancestry is missing or cross-company'
        USING ERRCODE = '55000';
    END IF;
    IF v_current.status IS DISTINCT FROM 'reversed' THEN
      RAISE EXCEPTION 'supplier payment correction ancestry contains a non-reversed entry'
        USING ERRCODE = '55000';
    END IF;

    v_ancestry_ids := pg_catalog.array_append(v_ancestry_ids, v_current_id);
    IF v_current.source_type = 'correction' THEN
      IF v_current.correction_of_id IS NULL THEN
        RAISE EXCEPTION 'supplier payment correction ancestry has a missing parent'
          USING ERRCODE = '55000';
      END IF;
      v_current_id := v_current.correction_of_id;
      v_ancestry_depth := v_ancestry_depth + 1;
    ELSE
      IF v_current.correction_of_id IS NOT NULL THEN
        RAISE EXCEPTION 'supplier payment correction ancestry has a malformed root'
          USING ERRCODE = '55000';
      END IF;
      v_root_journal_entry_id := v_current_id;
      EXIT;
    END IF;
  END LOOP;

  -- Every retry and every descendant cancellation for one supplier-payment
  -- root shares this transaction-scoped linearization point. Row locks below
  -- still protect against correction inserts and direct state mutations.
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'supplier-payment-reversal:' || p_company_id::text
      || ':' || v_root_journal_entry_id::text,
      0
    )
  );

  -- Lock the exact ancestry and requested storno in UUID order. Then lock all
  -- existing correction children while their parent rows are already locked.
  -- A concurrent child insert must finish before the parent lock is acquired
  -- or wait until this transaction ends; the second query sees and validates
  -- every child that won the race.
  PERFORM je.id
    FROM public.journal_entries je
   WHERE je.id = ANY (
     v_ancestry_ids || ARRAY[p_storno_journal_entry_id]::uuid[]
   )
   ORDER BY je.id
   FOR UPDATE;

  PERFORM correction.id
    FROM public.journal_entries correction
   WHERE correction.correction_of_id = ANY(v_ancestry_ids)
   ORDER BY correction.id
   FOR UPDATE;

  SELECT je.company_id, je.status, je.source_type, je.source_id,
         je.reversed_by_id, je.correction_of_id
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

  SELECT je.company_id, je.status, je.source_type, je.source_id,
         je.reversed_by_id, je.correction_of_id
    INTO v_root
    FROM public.journal_entries je
   WHERE je.id = v_root_journal_entry_id;
  IF NOT FOUND
     OR v_root.company_id IS DISTINCT FROM p_company_id
     OR v_root.status IS DISTINCT FROM 'reversed'
     OR v_root.source_type NOT IN (
       'supplier_invoice_paid',
       'supplier_invoice_cash_payment',
       'manual'
     ) THEN
    RAISE EXCEPTION 'supplier payment reversal root journal entry mismatch'
      USING ERRCODE = '23514';
  END IF;

  -- The committed ancestry must be one exact forward chain from root to the
  -- requested cancellation. Draft siblings are live construction and block;
  -- cancelled artifacts are retained but ignored. Any committed child outside
  -- the exact path is malformed lineage and also blocks.
  FOR v_ancestry_index IN REVERSE
    pg_catalog.array_length(v_ancestry_ids, 1)..1
  LOOP
    v_expected_child_id := CASE
      WHEN v_ancestry_index > 1 THEN v_ancestry_ids[v_ancestry_index - 1]
      ELSE NULL
    END;

    SELECT count(*)::integer
      INTO v_live_child_count
      FROM public.journal_entries correction
     WHERE correction.company_id = p_company_id
       AND correction.correction_of_id = v_ancestry_ids[v_ancestry_index]
       AND correction.source_type = 'correction'
       AND correction.status IN ('draft', 'posted', 'reversed');

    IF v_expected_child_id IS NULL THEN
      IF v_live_child_count <> 0 THEN
        RAISE EXCEPTION
          'supplier payment reversal blocked by live correction child'
          USING ERRCODE = '55000';
      END IF;
    ELSIF v_live_child_count <> 1
       OR NOT EXISTS (
         SELECT 1
           FROM public.journal_entries correction
          WHERE correction.id = v_expected_child_id
            AND correction.company_id = p_company_id
            AND correction.correction_of_id
                = v_ancestry_ids[v_ancestry_index]
            AND correction.source_type = 'correction'
            AND correction.status = 'reversed'
       ) THEN
      RAISE EXCEPTION
        'supplier payment reversal blocked by live correction child'
        USING ERRCODE = '55000';
    END IF;
  END LOOP;

  -- Lock every historical and active allocation attached anywhere in the
  -- ancestry. Supplier semantics belong only to the exact root; an allocation
  -- on a correction descendant is malformed and never inferred.
  PERFORM sip.id
    FROM public.supplier_invoice_payments sip
   WHERE sip.journal_entry_id = ANY(v_ancestry_ids)
   ORDER BY sip.id
   FOR UPDATE;

  IF EXISTS (
    SELECT 1
      FROM public.supplier_invoice_payments sip
     WHERE sip.journal_entry_id = ANY(v_ancestry_ids)
       AND sip.journal_entry_id IS DISTINCT FROM v_root_journal_entry_id
  ) THEN
    RAISE EXCEPTION 'supplier payment correction ancestry has a non-root allocation'
      USING ERRCODE = '55000';
  END IF;

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
   WHERE sip.journal_entry_id = v_root_journal_entry_id;

  IF EXISTS (
    SELECT 1
      FROM public.supplier_invoice_payments sip
     WHERE sip.journal_entry_id = v_root_journal_entry_id
       AND (
         sip.company_id IS DISTINCT FROM p_company_id
         OR sip.amount IS NULL
         OR round(sip.amount, 2) <= 0
       )
  ) THEN
    RAISE EXCEPTION 'supplier payment reversal allocation ownership or amount mismatch'
      USING ERRCODE = '55000';
  END IF;

  -- Manual vouchers are supplier-payment targets only when the sanctioned
  -- voucher-link flow left exact retained allocations. Never infer supplier
  -- semantics for an allocation-less manual reversal.
  IF v_root.source_type = 'manual' AND v_total_count = 0 THEN
    RAISE EXCEPTION 'manual supplier payment reversal has no retained allocations'
      USING ERRCODE = '55000';
  END IF;


  IF v_total_count = 0 THEN
    IF v_root.source_type = 'supplier_invoice_paid' THEN
      -- Compatibility recovery for the v1 mark-paid ordering: the posted
      -- voucher and invoice mutation may exist even when its explicitly
      -- non-blocking allocation insert failed. The exact source pointer,
      -- one unambiguous 2440 debit, the invoice before-state, and the durable
      -- event outbox marker bound this path. No other allocation-free payment
      -- source acquires this capability.
      IF v_root.source_id IS NULL THEN
        RAISE EXCEPTION 'supplier payment recovery has no source invoice'
          USING ERRCODE = '55000';
      END IF;

      SELECT si.id, si.company_id, si.status, si.paid_at, si.paid_amount,
             si.remaining_amount, si.total, si.due_date,
             si.payment_journal_entry_id, si.is_credit_note
        INTO v_v1_invoice
        FROM public.supplier_invoices si
       WHERE si.id = v_root.source_id
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
       WHERE jel.journal_entry_id = v_root_journal_entry_id;

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
           AND je.reverses_id = v_root_journal_entry_id
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
       WHERE t.journal_entry_id = v_root_journal_entry_id
       ORDER BY t.id
       FOR UPDATE;

      IF EXISTS (
        SELECT 1
          FROM public.transactions t
         WHERE t.journal_entry_id = v_root_journal_entry_id
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
        IF v_v1_invoice.payment_journal_entry_id = v_root_journal_entry_id
           OR EXISTS (
             SELECT 1
               FROM public.transactions t
              WHERE t.journal_entry_id = v_root_journal_entry_id
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
            IS DISTINCT FROM v_root_journal_entry_id
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
         AND si.payment_journal_entry_id = v_root_journal_entry_id;
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
         AND t.journal_entry_id = v_root_journal_entry_id
         AND t.invoice_id IS NULL
         AND (
           t.supplier_invoice_id IS NULL
           OR t.supplier_invoice_id = v_v1_invoice.id
         );
      GET DIAGNOSTICS v_released_count = ROW_COUNT;
      IF EXISTS (
        SELECT 1
          FROM public.transactions t
         WHERE t.journal_entry_id = v_root_journal_entry_id
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
    IF v_root.source_type IS DISTINCT FROM 'supplier_invoice_cash_payment'
       OR v_root.source_id IS NULL THEN
      RAISE EXCEPTION 'supplier payment reversal has no retained allocations'
        USING ERRCODE = '55000';
    END IF;

    SELECT si.id, si.company_id, si.status, si.paid_at, si.paid_amount,
           si.remaining_amount, si.total, si.due_date,
           si.payment_journal_entry_id
      INTO v_legacy_invoice
      FROM public.supplier_invoices si
     WHERE si.id = v_root.source_id
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
         IS DISTINCT FROM v_root_journal_entry_id
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
       AND t.journal_entry_id = v_root_journal_entry_id;
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

  -- Lock every transaction retained by this payment before either an exact
  -- retry return or active-state validation. The lock is held through invoice
  -- restoration, transaction release, and allocation reversal, so a concurrent
  -- relink cannot pass validation and then escape the release UPDATE.
  PERFORM t.id
    FROM public.transactions t
   WHERE t.id IN (
     SELECT sip.transaction_id
       FROM public.supplier_invoice_payments sip
      WHERE sip.journal_entry_id = v_root_journal_entry_id
        AND sip.transaction_id IS NOT NULL
   )
   ORDER BY t.id
   FOR UPDATE;

  IF EXISTS (
    SELECT 1
      FROM public.supplier_invoice_payments sip
      LEFT JOIN public.transactions t ON t.id = sip.transaction_id
     WHERE sip.journal_entry_id = v_root_journal_entry_id
       AND sip.transaction_id IS NOT NULL
       AND (
         t.id IS NULL
         OR t.company_id IS DISTINCT FROM p_company_id
         OR (
           v_active_count > 0
           AND (
             (
               t.journal_entry_id IS NOT NULL
               AND t.journal_entry_id IS DISTINCT FROM v_root_journal_entry_id
               AND t.journal_entry_id IS DISTINCT FROM p_original_journal_entry_id
             )
             OR t.invoice_id IS NOT NULL
             OR (
               t.supplier_invoice_id IS NOT NULL
               AND t.supplier_invoice_id IS DISTINCT FROM sip.supplier_invoice_id
             )
           )
         )
         OR (
           v_active_count = 0
           AND (
             t.journal_entry_id IS NOT NULL
             OR t.invoice_id IS NOT NULL
             OR t.supplier_invoice_id IS NOT NULL
             OR t.is_business IS NOT NULL
             OR t.category IS NOT NULL
           )
         )
       )
  ) OR EXISTS (
    SELECT 1
      FROM public.supplier_invoice_payments selected
      JOIN public.supplier_invoice_payments current_allocation
        ON current_allocation.transaction_id = selected.transaction_id
       AND current_allocation.reversed_at IS NULL
       AND current_allocation.journal_entry_id
          IS DISTINCT FROM v_root_journal_entry_id
     WHERE selected.journal_entry_id = v_root_journal_entry_id
       AND selected.transaction_id IS NOT NULL
  ) THEN
    RAISE EXCEPTION 'supplier payment reversal transaction ownership conflict'
      USING ERRCODE = '55000';
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
         WHERE sip.journal_entry_id = v_root_journal_entry_id
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
      WHERE sip.journal_entry_id = v_root_journal_entry_id
        AND sip.reversed_at IS NULL
   )
   ORDER BY si.id
   FOR UPDATE;

  SELECT count(DISTINCT sip.supplier_invoice_id)::integer
    INTO v_expected_invoice_count
    FROM public.supplier_invoice_payments sip
   WHERE sip.journal_entry_id = v_root_journal_entry_id
     AND sip.reversed_at IS NULL;
  SELECT count(*)::integer
    INTO v_invoice_count
    FROM public.supplier_invoices si
   WHERE si.company_id = p_company_id
     AND si.id IN (
       SELECT sip.supplier_invoice_id
         FROM public.supplier_invoice_payments sip
        WHERE sip.journal_entry_id = v_root_journal_entry_id
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
         WHERE sip.journal_entry_id = v_root_journal_entry_id
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

  WITH amounts AS (
    SELECT sip.supplier_invoice_id,
           round(sum(sip.amount), 2) AS payment_amount
      FROM public.supplier_invoice_payments sip
     WHERE sip.journal_entry_id = v_root_journal_entry_id
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
           WHEN si.payment_journal_entry_id = v_root_journal_entry_id THEN NULL
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
       t.journal_entry_id = v_root_journal_entry_id
       OR (
         t.id IN (
           SELECT sip.transaction_id
             FROM public.supplier_invoice_payments sip
            WHERE sip.journal_entry_id = v_root_journal_entry_id
              AND sip.reversed_at IS NULL
              AND sip.transaction_id IS NOT NULL
         )
         AND (
          t.journal_entry_id IS NULL
          OR t.journal_entry_id = p_original_journal_entry_id
        )
         AND t.invoice_id IS NULL
         AND (
           t.supplier_invoice_id IS NULL
           OR EXISTS (
             SELECT 1
               FROM public.supplier_invoice_payments sip
              WHERE sip.journal_entry_id = v_root_journal_entry_id
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
    v_root_journal_entry_id::text || ':' || p_storno_journal_entry_id::text,
    true
  );
  UPDATE public.supplier_invoice_payments sip
     SET reversed_at = v_reversed_at,
         reversed_by_journal_entry_id = p_storno_journal_entry_id
   WHERE sip.journal_entry_id = v_root_journal_entry_id
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

ALTER FUNCTION public.apply_supplier_payment_reversal(uuid, uuid, uuid)
  OWNER TO postgres;

COMMENT ON FUNCTION public.apply_supplier_payment_reversal(uuid, uuid, uuid) IS
  'Atomically resolves a cancelled supplier-payment correction descendant to its exact typed or allocation-backed manual root, restores supplier state once, retains allocation lineage, and releases only root-owned transaction pointers.';

REVOKE ALL ON FUNCTION public.apply_supplier_payment_reversal(uuid, uuid, uuid)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.apply_supplier_payment_reversal(uuid, uuid, uuid)
  TO authenticated, service_role;

NOTIFY pgrst, 'reload schema';
