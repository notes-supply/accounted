-- WP5 P1 shared journal lineage and durable accounting publication foundation.
-- Symbolic draft: allocate a numeric migration version only at candidate freeze.
--
-- Exactly-once in this contract means one durable database identity for each
-- accounting publication key, one event_log row for that publication, and one
-- webhook_deliveries row for each subscriber captured by its first snapshot.
-- Webhook HTTP delivery remains at-least-once. In-process extension dispatch
-- remains best effort.

-- ---------------------------------------------------------------------------
-- 0. Private transaction capabilities for trusted accounting commands
-- ---------------------------------------------------------------------------

CREATE SCHEMA accounting_private;
REVOKE ALL ON SCHEMA accounting_private
  FROM PUBLIC, anon, authenticated, service_role;

CREATE TABLE accounting_private.accounting_command_capabilities (
  backend_pid integer NOT NULL,
  transaction_id xid8 NOT NULL,
  action text NOT NULL,
  company_id uuid NOT NULL,
  target_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT accounting_command_capabilities_action_nonempty
    CHECK (length(btrim(action)) BETWEEN 1 AND 128),
  CONSTRAINT accounting_command_capabilities_identity
    PRIMARY KEY (backend_pid, transaction_id, action, company_id, target_id)
);

ALTER TABLE accounting_private.accounting_command_capabilities
  ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE accounting_private.accounting_command_capabilities
  FROM PUBLIC, anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION accounting_private.grant_accounting_command_capability(
  p_action text,
  p_company_id uuid,
  p_target_id uuid
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'pg_catalog', 'accounting_private'
AS $function$
BEGIN
  IF p_action IS NULL
     OR length(btrim(p_action)) NOT BETWEEN 1 AND 128
     OR p_company_id IS NULL
     OR p_target_id IS NULL THEN
    RAISE EXCEPTION 'Complete accounting command capability identity is required'
      USING ERRCODE = '22004';
  END IF;

  INSERT INTO accounting_private.accounting_command_capabilities (
    backend_pid, transaction_id, action, company_id, target_id
  ) VALUES (
    pg_backend_pid(), pg_current_xact_id(), p_action, p_company_id, p_target_id
  )
  ON CONFLICT DO NOTHING;
END;
$function$;

CREATE OR REPLACE FUNCTION accounting_private.has_accounting_command_capability(
  p_action text,
  p_company_id uuid,
  p_target_id uuid
)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'pg_catalog', 'accounting_private'
AS $function$
  SELECT EXISTS (
    SELECT 1
    FROM accounting_private.accounting_command_capabilities capability
    WHERE capability.backend_pid = pg_backend_pid()
      AND capability.transaction_id = pg_current_xact_id_if_assigned()
      AND capability.action = p_action
      AND capability.company_id = p_company_id
      AND capability.target_id = p_target_id
  )
$function$;

CREATE OR REPLACE FUNCTION accounting_private.revoke_accounting_command_capability(
  p_action text,
  p_company_id uuid,
  p_target_id uuid
)
RETURNS void
LANGUAGE sql
SECURITY DEFINER
SET search_path TO 'pg_catalog', 'accounting_private'
AS $function$
  DELETE FROM accounting_private.accounting_command_capabilities capability
  WHERE capability.backend_pid = pg_backend_pid()
    AND capability.transaction_id = pg_current_xact_id_if_assigned()
    AND capability.action = p_action
    AND capability.company_id = p_company_id
    AND capability.target_id = p_target_id
$function$;

CREATE OR REPLACE FUNCTION accounting_private.revoke_all_accounting_command_capabilities()
RETURNS void
LANGUAGE sql
SECURITY DEFINER
SET search_path TO 'pg_catalog', 'accounting_private'
AS $function$
  DELETE FROM accounting_private.accounting_command_capabilities capability
  WHERE capability.backend_pid = pg_backend_pid()
    AND capability.transaction_id = pg_current_xact_id_if_assigned()
$function$;

REVOKE ALL ON FUNCTION accounting_private.grant_accounting_command_capability(text, uuid, uuid)
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION accounting_private.has_accounting_command_capability(text, uuid, uuid)
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION accounting_private.revoke_accounting_command_capability(text, uuid, uuid)
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION accounting_private.revoke_all_accounting_command_capabilities()
  FROM PUBLIC, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 1. Correction and storno edge integrity
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.validate_journal_lineage_edge()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path TO 'pg_catalog', 'public'
AS $function$
DECLARE
  v_parent_id uuid;
  v_parent record;
  v_reversal record;
  v_correction_ancestors integer := 0;
  v_cycle boolean := false;
  v_cross_company boolean := false;
  v_edge_depth integer;
BEGIN
  IF NEW.source_type = 'correction' THEN
    IF NEW.correction_of_id IS NULL OR NEW.reverses_id IS NOT NULL THEN
      RAISE EXCEPTION 'Correction entry % must have exactly one correction_of_id edge', NEW.id
        USING ERRCODE = '23514';
    END IF;
    v_parent_id := NEW.correction_of_id;
  ELSIF NEW.source_type = 'storno' THEN
    IF NEW.reverses_id IS NULL OR NEW.correction_of_id IS NOT NULL THEN
      RAISE EXCEPTION 'Storno entry % must have exactly one reverses_id edge', NEW.id
        USING ERRCODE = '23514';
    END IF;
    IF NEW.reversed_by_id IS NOT NULL THEN
      RAISE EXCEPTION 'Storno entry % is terminal and cannot be reversed', NEW.id
        USING ERRCODE = '23514';
    END IF;
    v_parent_id := NEW.reverses_id;
  ELSE
    IF NEW.correction_of_id IS NOT NULL OR NEW.reverses_id IS NOT NULL THEN
      RAISE EXCEPTION 'Non-lineage entry % cannot claim a correction or storno edge', NEW.id
        USING ERRCODE = '23514';
    END IF;
  END IF;

  IF NEW.correction_of_id = NEW.id OR NEW.reverses_id = NEW.id OR NEW.reversed_by_id = NEW.id THEN
    RAISE EXCEPTION 'Journal entry % cannot reference itself in lineage', NEW.id
      USING ERRCODE = '23514';
  END IF;

  IF NEW.status = 'reversed' AND NEW.reversed_by_id IS NULL THEN
    RAISE EXCEPTION 'Reversed journal entry % must identify its storno', NEW.id
      USING ERRCODE = '23514';
  ELSIF NEW.status IS DISTINCT FROM 'reversed' AND NEW.reversed_by_id IS NOT NULL THEN
    RAISE EXCEPTION 'Only a reversed journal entry may identify a storno: %', NEW.id
      USING ERRCODE = '23514';
  END IF;

  IF NEW.reversed_by_id IS NOT NULL THEN
    SELECT
      entry.id,
      entry.company_id,
      entry.source_type,
      entry.reverses_id,
      entry.correction_of_id,
      entry.status
    INTO v_reversal
    FROM public.journal_entries entry
    WHERE entry.id = NEW.reversed_by_id;

    IF NOT FOUND
       OR v_reversal.company_id IS DISTINCT FROM NEW.company_id
       OR v_reversal.source_type IS DISTINCT FROM 'storno'
       OR v_reversal.reverses_id IS DISTINCT FROM NEW.id
       OR v_reversal.correction_of_id IS NOT NULL
       OR v_reversal.status IS DISTINCT FROM 'posted' THEN
      RAISE EXCEPTION 'Journal entry % has a contradictory reversed_by_id edge', NEW.id
        USING ERRCODE = '23514';
    END IF;
  END IF;

  IF v_parent_id IS NULL THEN
    RETURN NEW;
  END IF;

  SELECT entry.id, entry.company_id, entry.source_type
  INTO v_parent
  FROM public.journal_entries entry
  WHERE entry.id = v_parent_id;

  IF NOT FOUND OR v_parent.company_id IS DISTINCT FROM NEW.company_id THEN
    RAISE EXCEPTION 'Journal lineage parent for entry % is missing from its company scope', NEW.id
      USING ERRCODE = '23514';
  END IF;

  IF v_parent.source_type = 'storno' THEN
    RAISE EXCEPTION 'Terminal storno entry % cannot have a lineage child', v_parent_id
      USING ERRCODE = '23514';
  END IF;

  WITH RECURSIVE ancestry AS (
    SELECT
      parent.id,
      parent.company_id,
      parent.source_type,
      parent.correction_of_id,
      ARRAY[NEW.id, parent.id]::uuid[] AS path,
      parent.id = NEW.id AS cycle
    FROM public.journal_entries parent
    WHERE parent.id = v_parent_id

    UNION ALL

    SELECT
      parent.id,
      parent.company_id,
      parent.source_type,
      parent.correction_of_id,
      ancestry.path || parent.id,
      parent.id = ANY(ancestry.path)
    FROM ancestry
    JOIN public.journal_entries parent
      ON parent.id = ancestry.correction_of_id
    WHERE ancestry.correction_of_id IS NOT NULL
      AND NOT ancestry.cycle
      AND pg_catalog.cardinality(ancestry.path) <= 34
  )
  SELECT
    pg_catalog.count(*) FILTER (WHERE source_type = 'correction')::integer,
    COALESCE(pg_catalog.bool_or(cycle), false),
    COALESCE(pg_catalog.bool_or(company_id IS DISTINCT FROM NEW.company_id), false)
  INTO v_correction_ancestors, v_cycle, v_cross_company
  FROM ancestry;

  IF v_cycle THEN
    RAISE EXCEPTION 'Journal lineage cycle detected for entry %', NEW.id
      USING ERRCODE = '23514';
  END IF;

  IF v_cross_company THEN
    RAISE EXCEPTION 'Journal lineage for entry % crosses company scope', NEW.id
      USING ERRCODE = '23514';
  END IF;

  v_edge_depth := v_correction_ancestors + 1;
  IF NEW.source_type = 'correction' AND v_edge_depth > 32 THEN
    RAISE EXCEPTION 'Journal correction depth exceeds 32 for entry %', NEW.id
      USING ERRCODE = '54000';
  END IF;
  IF NEW.source_type = 'storno' AND v_edge_depth > 33 THEN
    RAISE EXCEPTION 'Journal storno depth exceeds terminal depth 33 for entry %', NEW.id
      USING ERRCODE = '54000';
  END IF;

  RETURN NEW;
END;
$function$;

REVOKE ALL ON FUNCTION public.validate_journal_lineage_edge()
  FROM PUBLIC, anon, authenticated, service_role;

-- Validate the existing postimage before installing authoritative indexes and
-- the trigger. Any historical contradiction aborts the migration unchanged.
DO $validation$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM public.journal_entries entry
    WHERE
      (entry.source_type = 'correction'
       AND (entry.correction_of_id IS NULL OR entry.reverses_id IS NOT NULL))
      OR (entry.source_type = 'storno'
          AND (entry.reverses_id IS NULL
               OR entry.correction_of_id IS NOT NULL
               OR entry.reversed_by_id IS NOT NULL))
      OR (entry.source_type NOT IN ('correction', 'storno')
          AND (entry.correction_of_id IS NOT NULL OR entry.reverses_id IS NOT NULL))
      OR entry.correction_of_id = entry.id
      OR entry.reverses_id = entry.id
      OR entry.reversed_by_id = entry.id
      OR (entry.status = 'reversed') IS DISTINCT FROM (entry.reversed_by_id IS NOT NULL)
  ) THEN
    RAISE EXCEPTION 'Existing journal lineage contains contradictory edge columns'
      USING ERRCODE = '23514';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM public.journal_entries child
    LEFT JOIN public.journal_entries parent
      ON parent.id = COALESCE(child.correction_of_id, child.reverses_id)
    WHERE (child.correction_of_id IS NOT NULL OR child.reverses_id IS NOT NULL)
      AND (
        parent.id IS NULL
        OR parent.company_id IS DISTINCT FROM child.company_id
        OR parent.source_type = 'storno'
      )
  ) THEN
    RAISE EXCEPTION 'Existing journal lineage contains a missing, cross-company, or terminal parent'
      USING ERRCODE = '23514';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM public.journal_entries parent
    LEFT JOIN public.journal_entries storno
      ON storno.id = parent.reversed_by_id
    WHERE parent.reversed_by_id IS NOT NULL
      AND (
        storno.id IS NULL
        OR storno.company_id IS DISTINCT FROM parent.company_id
        OR storno.source_type IS DISTINCT FROM 'storno'
        OR storno.reverses_id IS DISTINCT FROM parent.id
        OR storno.correction_of_id IS NOT NULL
        OR storno.status IS DISTINCT FROM 'posted'
      )
  ) THEN
    RAISE EXCEPTION 'Existing journal lineage contains a contradictory reverse pointer'
      USING ERRCODE = '23514';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM public.journal_entries entry
    WHERE entry.status IN ('posted', 'reversed')
      AND entry.committed_at IS NULL
  ) THEN
    RAISE EXCEPTION 'Existing posted journal lineage contains a null committed_at'
      USING ERRCODE = '23514';
  END IF;

  IF EXISTS (
    WITH RECURSIVE correction_ancestry AS (
      SELECT
        entry.id AS start_id,
        entry.id,
        entry.correction_of_id,
        ARRAY[entry.id]::uuid[] AS path,
        1 AS correction_depth,
        false AS cycle
      FROM public.journal_entries entry
      WHERE entry.source_type = 'correction'

      UNION ALL

      SELECT
        correction_ancestry.start_id,
        parent.id,
        parent.correction_of_id,
        correction_ancestry.path || parent.id,
        correction_ancestry.correction_depth + 1,
        parent.id = ANY(correction_ancestry.path)
      FROM correction_ancestry
      JOIN public.journal_entries parent
        ON parent.id = correction_ancestry.correction_of_id
       AND parent.source_type = 'correction'
      WHERE NOT correction_ancestry.cycle
        AND correction_ancestry.correction_depth <= 32
    )
    SELECT 1
    FROM correction_ancestry
    WHERE cycle OR correction_depth > 32
  ) THEN
    RAISE EXCEPTION 'Existing journal lineage contains a cycle or correction depth above 32'
      USING ERRCODE = '23514';
  END IF;
END;
$validation$;

CREATE UNIQUE INDEX uq_journal_entries_committed_correction_child
  ON public.journal_entries (correction_of_id)
  WHERE source_type = 'correction'
    AND correction_of_id IS NOT NULL
    AND status IN ('posted', 'reversed');

CREATE UNIQUE INDEX uq_journal_entries_committed_storno_child
  ON public.journal_entries (reverses_id)
  WHERE source_type = 'storno'
    AND reverses_id IS NOT NULL
    AND status IN ('posted', 'reversed');

CREATE UNIQUE INDEX uq_journal_entries_committed_reverse_pointer
  ON public.journal_entries (reversed_by_id)
  WHERE reversed_by_id IS NOT NULL
    AND status = 'reversed';

CREATE TRIGGER validate_journal_lineage_edge
  BEFORE INSERT OR UPDATE OF company_id, source_type, correction_of_id,
    reverses_id, reversed_by_id, status
  ON public.journal_entries
  FOR EACH ROW
  EXECUTE FUNCTION public.validate_journal_lineage_edge();

CREATE OR REPLACE FUNCTION public.journal_lineage_final_state_is_valid(
  p_entry_id uuid
)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'pg_catalog', 'public'
AS $function$
  WITH affected_ids AS (
    SELECT p_entry_id AS id
    UNION
    SELECT entry.correction_of_id
    FROM public.journal_entries entry
    WHERE entry.id = p_entry_id
      AND entry.correction_of_id IS NOT NULL
    UNION
    SELECT entry.reverses_id
    FROM public.journal_entries entry
    WHERE entry.id = p_entry_id
      AND entry.reverses_id IS NOT NULL
    UNION
    SELECT child.id
    FROM public.journal_entries child
    WHERE child.correction_of_id = p_entry_id
       OR child.reverses_id = p_entry_id
  ),
  nodes AS (
    SELECT entry.*
    FROM public.journal_entries entry
    JOIN affected_ids affected ON affected.id = entry.id
    WHERE entry.status IN ('posted', 'reversed')
  ),
  checked AS (
    SELECT
      node.*,
      parent.id AS parent_row_id,
      parent.company_id AS parent_company_id,
      parent.source_type AS parent_source_type,
      reversal.id AS reversal_row_id,
      reversal.company_id AS reversal_company_id,
      reversal.source_type AS reversal_source_type,
      reversal.reverses_id AS reversal_reverses_id,
      reversal.status AS reversal_status,
      relationships.correction_count,
      relationships.storno_count,
      relationships.storno_id,
      relationships.child_count
    FROM nodes node
    LEFT JOIN public.journal_entries parent
      ON parent.id = COALESCE(node.correction_of_id, node.reverses_id)
    LEFT JOIN public.journal_entries reversal
      ON reversal.id = node.reversed_by_id
    CROSS JOIN LATERAL (
      SELECT
        count(*) FILTER (
          WHERE child.source_type = 'correction'
            AND child.correction_of_id = node.id
            AND child.status IN ('posted', 'reversed')
        )::integer AS correction_count,
        count(*) FILTER (
          WHERE child.source_type = 'storno'
            AND child.reverses_id = node.id
            AND child.status IN ('posted', 'reversed')
        )::integer AS storno_count,
        (array_agg(child.id ORDER BY child.id) FILTER (
          WHERE child.source_type = 'storno'
            AND child.reverses_id = node.id
            AND child.status IN ('posted', 'reversed')
        ))[1] AS storno_id,
        count(*) FILTER (
          WHERE child.status IN ('posted', 'reversed')
            AND (
              child.correction_of_id = node.id
              OR child.reverses_id = node.id
            )
        )::integer AS child_count
      FROM public.journal_entries child
      WHERE child.correction_of_id = node.id
         OR child.reverses_id = node.id
    ) relationships
  )
  SELECT NOT EXISTS (
    SELECT 1
    FROM checked node
    WHERE node.committed_at IS NULL
       OR (
         node.source_type = 'correction'
         AND (
           node.correction_of_id IS NULL
           OR node.reverses_id IS NOT NULL
           OR node.parent_row_id IS NULL
           OR node.parent_company_id IS DISTINCT FROM node.company_id
           OR node.parent_source_type = 'storno'
         )
       )
       OR (
         node.source_type = 'storno'
         AND (
           node.reverses_id IS NULL
           OR node.correction_of_id IS NOT NULL
           OR node.reversed_by_id IS NOT NULL
           OR node.parent_row_id IS NULL
           OR node.parent_company_id IS DISTINCT FROM node.company_id
           OR node.parent_source_type = 'storno'
           OR node.status IS DISTINCT FROM 'posted'
           OR node.child_count <> 0
         )
       )
       OR (
         node.source_type NOT IN ('correction', 'storno')
         AND (node.correction_of_id IS NOT NULL OR node.reverses_id IS NOT NULL)
       )
       OR node.correction_count > 1
       OR node.storno_count > 1
       OR (
         node.status = 'posted'
         AND (
           node.reversed_by_id IS NOT NULL
           OR node.storno_count <> 0
           OR node.correction_count <> 0
         )
       )
       OR (
         node.status = 'reversed'
         AND (
           node.storno_count <> 1
           OR node.reversed_by_id IS DISTINCT FROM node.storno_id
           OR node.reversal_row_id IS NULL
           OR node.reversal_company_id IS DISTINCT FROM node.company_id
           OR node.reversal_source_type IS DISTINCT FROM 'storno'
           OR node.reversal_reverses_id IS DISTINCT FROM node.id
           OR node.reversal_status IS DISTINCT FROM 'posted'
         )
       )
  )
$function$;

REVOKE ALL ON FUNCTION public.journal_lineage_final_state_is_valid(uuid)
  FROM PUBLIC, anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION public.validate_journal_lineage_final_state()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'pg_catalog', 'public'
AS $function$
DECLARE
  v_entry_id uuid;
  v_entry_ids uuid[];
BEGIN
  IF TG_OP = 'DELETE' THEN
    v_entry_ids := ARRAY[OLD.id, OLD.correction_of_id, OLD.reverses_id];
  ELSIF TG_OP = 'UPDATE' THEN
    v_entry_ids := ARRAY[
      NEW.id, NEW.correction_of_id, NEW.reverses_id,
      OLD.correction_of_id, OLD.reverses_id
    ];
  ELSE
    v_entry_ids := ARRAY[NEW.id, NEW.correction_of_id, NEW.reverses_id];
  END IF;

  FOREACH v_entry_id IN ARRAY v_entry_ids LOOP
    IF v_entry_id IS NOT NULL
       AND NOT public.journal_lineage_final_state_is_valid(v_entry_id) THEN
      RAISE EXCEPTION 'Journal lineage final state is contradictory'
        USING ERRCODE = '23514';
    END IF;
  END LOOP;

  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$function$;

REVOKE ALL ON FUNCTION public.validate_journal_lineage_final_state()
  FROM PUBLIC, anon, authenticated, service_role;

DO $final_validation$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM public.journal_entries entry
    WHERE entry.status IN ('posted', 'reversed')
      AND NOT public.journal_lineage_final_state_is_valid(entry.id)
  ) THEN
    RAISE EXCEPTION 'Existing journal lineage has a contradictory final state'
      USING ERRCODE = '23514';
  END IF;
END;
$final_validation$;

CREATE CONSTRAINT TRIGGER validate_journal_lineage_final_state
  AFTER INSERT OR UPDATE OR DELETE ON public.journal_entries
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW
  EXECUTE FUNCTION public.validate_journal_lineage_final_state();

-- Complete descendant closure for a bounded set of true lineage roots. The
-- function raises on every malformed condition. It never returns a truncated
-- or partially trusted graph.
CREATE OR REPLACE FUNCTION public.get_journal_lineage(
  p_company_id uuid,
  p_root_ids uuid[]
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY INVOKER
SET search_path TO 'pg_catalog', 'public'
AS $function$
DECLARE
  v_max_correction_depth constant integer := 32;
  v_terminal_storno_depth constant integer := 33;
  v_max_rows constant integer := 20000;
  v_requested_root_count integer;
  v_resolved_root_count integer;
  v_row_count integer;
  v_max_depth integer;
  v_max_correction_depth_seen integer;
  v_terminal_storno_depth_seen integer;
  v_malformed boolean;
  v_rows jsonb;
BEGIN
  IF p_company_id IS NULL THEN
    RAISE EXCEPTION 'Journal lineage company is required'
      USING ERRCODE = '22004';
  END IF;
  IF p_root_ids IS NULL OR pg_catalog.cardinality(p_root_ids) = 0 THEN
    RAISE EXCEPTION 'Journal lineage roots are required'
      USING ERRCODE = '22004';
  END IF;
  IF pg_catalog.cardinality(p_root_ids) > v_max_rows THEN
    RAISE EXCEPTION 'Journal lineage accepts at most % roots', v_max_rows
      USING ERRCODE = '54000';
  END IF;
  IF pg_catalog.array_position(p_root_ids, NULL::uuid) IS NOT NULL THEN
    RAISE EXCEPTION 'Journal lineage roots cannot contain null'
      USING ERRCODE = '22004';
  END IF;

  SELECT pg_catalog.count(*)::integer
  INTO v_requested_root_count
  FROM (
    SELECT DISTINCT root_id
    FROM pg_catalog.unnest(p_root_ids) AS requested(root_id)
  ) requested_roots;

  SELECT pg_catalog.count(*)::integer
  INTO v_resolved_root_count
  FROM (
    SELECT DISTINCT root_id
    FROM pg_catalog.unnest(p_root_ids) AS requested(root_id)
  ) requested_roots
  JOIN public.journal_entries root
    ON root.id = requested_roots.root_id
   AND root.company_id = p_company_id
   AND root.status IN ('posted', 'reversed')
   AND root.source_type NOT IN ('correction', 'storno')
   AND root.correction_of_id IS NULL
   AND root.reverses_id IS NULL;

  IF v_resolved_root_count IS DISTINCT FROM v_requested_root_count THEN
    RAISE EXCEPTION 'Journal lineage roots are missing, malformed, or outside company scope'
      USING ERRCODE = 'P0002';
  END IF;

  WITH RECURSIVE requested_roots AS (
    SELECT DISTINCT root_id
    FROM pg_catalog.unnest(p_root_ids) AS requested(root_id)
  ),
  lineage AS (
    SELECT
      requested.root_id,
      NULL::uuid AS parent_id,
      'root'::text AS edge_kind,
      root.id,
      root.company_id,
      root.entry_date,
      root.status,
      root.source_type,
      root.correction_of_id,
      root.reverses_id,
      root.reversed_by_id,
      root.committed_at,
      0 AS depth,
      ARRAY[root.id]::uuid[] AS path,
      false AS cycle
    FROM requested_roots requested
    JOIN public.journal_entries root
      ON root.id = requested.root_id
     AND root.company_id = p_company_id
     AND root.status IN ('posted', 'reversed')

    UNION ALL

    SELECT
      parent.root_id,
      parent.id,
      CASE
        WHEN child.correction_of_id = parent.id THEN 'correction'
        ELSE 'storno'
      END,
      child.id,
      child.company_id,
      child.entry_date,
      child.status,
      child.source_type,
      child.correction_of_id,
      child.reverses_id,
      child.reversed_by_id,
      child.committed_at,
      parent.depth + 1,
      parent.path || child.id,
      child.id = ANY(parent.path)
    FROM lineage parent
    JOIN public.journal_entries child
      ON child.company_id = p_company_id
     AND child.status IN ('posted', 'reversed')
     AND parent.edge_kind <> 'storno'
     AND parent.depth <= v_max_correction_depth
     AND (
       child.correction_of_id = parent.id
       OR child.reverses_id = parent.id
     )
    WHERE NOT parent.cycle
  ),
  bounded_lineage AS MATERIALIZED (
    SELECT *
    FROM lineage
    LIMIT v_max_rows + 1
  ),
  checked_lineage AS (
    SELECT
      node.*,
      pg_catalog.count(*) OVER (
        PARTITION BY node.root_id, node.id
      ) AS path_count,
      (
        SELECT pg_catalog.count(*)
        FROM bounded_lineage child
        WHERE child.root_id = node.root_id
          AND child.parent_id = node.id
          AND child.edge_kind = 'correction'
      ) AS correction_child_count,
      (
        SELECT pg_catalog.count(*)
        FROM bounded_lineage child
        WHERE child.root_id = node.root_id
          AND child.parent_id = node.id
          AND child.edge_kind = 'storno'
      ) AS storno_child_count,
      (
        SELECT child.id
        FROM bounded_lineage child
        WHERE child.root_id = node.root_id
          AND child.parent_id = node.id
          AND child.edge_kind = 'storno'
        ORDER BY child.id
        LIMIT 1
      ) AS storno_child_id
    FROM bounded_lineage node
  )
  SELECT
    pg_catalog.count(*)::integer,
    COALESCE(pg_catalog.max(depth), 0)::integer,
    COALESCE(
      pg_catalog.max(depth) FILTER (WHERE edge_kind IN ('root', 'correction')),
      0
    )::integer,
    pg_catalog.max(depth) FILTER (WHERE edge_kind = 'storno')::integer,
    COALESCE(pg_catalog.bool_or(
      cycle
      OR committed_at IS NULL
      OR company_id IS DISTINCT FROM p_company_id
      OR path_count <> 1
      OR pg_catalog.cardinality(path) <> depth + 1
      OR path[1] IS DISTINCT FROM root_id
      OR path[pg_catalog.cardinality(path)] IS DISTINCT FROM id
      OR correction_child_count > 1
      OR storno_child_count > 1
      OR (edge_kind = 'root' AND (
        parent_id IS NOT NULL
        OR id IS DISTINCT FROM root_id
        OR depth <> 0
      ))
      OR (edge_kind = 'correction' AND (
        source_type IS DISTINCT FROM 'correction'
        OR correction_of_id IS DISTINCT FROM parent_id
        OR reverses_id IS NOT NULL
        OR depth > v_max_correction_depth
      ))
      OR (edge_kind = 'storno' AND (
        source_type IS DISTINCT FROM 'storno'
        OR reverses_id IS DISTINCT FROM parent_id
        OR correction_of_id IS NOT NULL
        OR reversed_by_id IS NOT NULL
        OR status IS DISTINCT FROM 'posted'
        OR depth > v_terminal_storno_depth
        OR EXISTS (
          SELECT 1
          FROM public.journal_entries child
          WHERE child.company_id = p_company_id
            AND child.status IN ('posted', 'reversed')
            AND (
              child.correction_of_id = checked_lineage.id
              OR child.reverses_id = checked_lineage.id
            )
        )
      ))
      OR (edge_kind <> 'storno' AND (
        status NOT IN ('posted', 'reversed')
        OR (status = 'posted' AND (
          reversed_by_id IS NOT NULL
          OR storno_child_count <> 0
        ))
        OR (status = 'reversed' AND (
          storno_child_count <> 1
          OR reversed_by_id IS DISTINCT FROM storno_child_id
        ))
        OR (correction_child_count = 1 AND status IS DISTINCT FROM 'reversed')
      ))
    ), false),
    COALESCE(
      pg_catalog.jsonb_agg(
        pg_catalog.jsonb_build_object(
          'root_id', root_id,
          'parent_id', parent_id,
          'edge_kind', edge_kind,
          'id', id,
          'company_id', company_id,
          'entry_date', entry_date,
          'status', status,
          'source_type', source_type,
          'correction_of_id', correction_of_id,
          'reverses_id', reverses_id,
          'reversed_by_id', reversed_by_id,
          'committed_at', committed_at,
          'depth', depth,
          'path', path,
          'cycle', cycle
        )
        ORDER BY root_id, depth, path::text, edge_kind, id
      ),
      '[]'::jsonb
    )
  INTO
    v_row_count,
    v_max_depth,
    v_max_correction_depth_seen,
    v_terminal_storno_depth_seen,
    v_malformed,
    v_rows
  FROM checked_lineage;

  IF v_row_count > v_max_rows THEN
    RAISE EXCEPTION 'Journal lineage exceeds maximum emitted row count of %', v_max_rows
      USING ERRCODE = '54000';
  END IF;

  IF v_malformed THEN
    RAISE EXCEPTION 'Journal lineage is cyclic, contradictory, ambiguous, or outside its depth bounds'
      USING ERRCODE = '23514';
  END IF;

  RETURN pg_catalog.jsonb_build_object(
    'valid', true,
    'company_id', p_company_id,
    'requested_root_count', v_requested_root_count,
    'row_count', v_row_count,
    'max_depth', v_max_depth,
    'max_correction_depth', v_max_correction_depth_seen,
    'terminal_storno_depth', v_terminal_storno_depth_seen,
    'rows', v_rows
  );
END;
$function$;

REVOKE ALL ON FUNCTION public.get_journal_lineage(uuid, uuid[])
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_journal_lineage(uuid, uuid[])
  TO authenticated, service_role;

COMMENT ON FUNCTION public.get_journal_lineage(uuid, uuid[]) IS
  'Returns a complete company-scoped correction/storno descendant graph. Raises instead of returning malformed or truncated lineage.';

-- ---------------------------------------------------------------------------
-- 2. Generic durable accounting publication ledger
-- ---------------------------------------------------------------------------

CREATE TABLE public.accounting_publications (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  company_id uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  publication_key text NOT NULL,
  event_type text NOT NULL,
  entity_id uuid,
  user_id uuid NOT NULL,
  payload jsonb NOT NULL,
  subscriber_count integer NOT NULL DEFAULT 0,
  event_log_sequence bigint,
  created_at timestamptz NOT NULL DEFAULT now(),
  published_at timestamptz,
  CONSTRAINT accounting_publications_key_nonempty
    CHECK (length(btrim(publication_key)) BETWEEN 1 AND 512),
  CONSTRAINT accounting_publications_event_type_nonempty
    CHECK (length(btrim(event_type)) BETWEEN 1 AND 128),
  CONSTRAINT accounting_publications_payload_object
    CHECK (jsonb_typeof(payload) = 'object'),
  CONSTRAINT accounting_publications_subscriber_count_nonnegative
    CHECK (subscriber_count >= 0),
  CONSTRAINT accounting_publications_company_key_unique
    UNIQUE (company_id, publication_key),
  CONSTRAINT accounting_publications_id_company_unique
    UNIQUE (id, company_id),
  CONSTRAINT accounting_publications_event_log_sequence_unique
    UNIQUE (event_log_sequence)
);

CREATE TABLE public.accounting_publication_subscribers (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  publication_id uuid NOT NULL,
  company_id uuid NOT NULL,
  webhook_id uuid NOT NULL,
  api_version text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT accounting_publication_subscribers_publication_company_fkey
    FOREIGN KEY (publication_id, company_id)
    REFERENCES public.accounting_publications(id, company_id)
    ON DELETE CASCADE,
  CONSTRAINT accounting_publication_subscribers_api_version_nonempty
    CHECK (length(btrim(api_version)) BETWEEN 1 AND 64),
  CONSTRAINT accounting_publication_subscribers_publication_webhook_unique
    UNIQUE (publication_id, webhook_id),
  CONSTRAINT accounting_publication_subscribers_id_publication_unique
    UNIQUE (id, publication_id)
);

ALTER TABLE public.accounting_publications ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.accounting_publication_subscribers ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.accounting_publications
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON TABLE public.accounting_publication_subscribers
  FROM PUBLIC, anon, authenticated, service_role;

ALTER TABLE public.event_log
  ADD COLUMN accounting_publication_id uuid
    REFERENCES public.accounting_publications(id) ON DELETE CASCADE;

CREATE UNIQUE INDEX uq_event_log_accounting_publication
  ON public.event_log (accounting_publication_id)
  WHERE accounting_publication_id IS NOT NULL;

ALTER TABLE public.webhook_deliveries
  ADD COLUMN accounting_publication_subscriber_id uuid
    REFERENCES public.accounting_publication_subscribers(id) ON DELETE CASCADE;

CREATE UNIQUE INDEX uq_webhook_delivery_accounting_subscriber
  ON public.webhook_deliveries (accounting_publication_subscriber_id)
  WHERE accounting_publication_subscriber_id IS NOT NULL;

CREATE OR REPLACE FUNCTION public.accounting_journal_entry_event_object(
  p_company_id uuid,
  p_entry_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'pg_catalog', 'public'
AS $function$
DECLARE
  v_entry jsonb;
  v_lines jsonb;
BEGIN
  SELECT to_jsonb(entry)
  INTO v_entry
  FROM public.journal_entries entry
  WHERE entry.id = p_entry_id
    AND entry.company_id = p_company_id;

  IF v_entry IS NULL THEN
    RAISE EXCEPTION 'Accounting event journal entry is missing: %', p_entry_id
      USING ERRCODE = 'P0002';
  END IF;

  SELECT COALESCE(
    jsonb_agg(to_jsonb(line) ORDER BY line.sort_order, line.id),
    '[]'::jsonb
  )
  INTO v_lines
  FROM public.journal_entry_lines line
  WHERE line.journal_entry_id = p_entry_id;

  RETURN v_entry || jsonb_build_object('lines', v_lines);
END;
$function$;

REVOKE ALL ON FUNCTION public.accounting_journal_entry_event_object(uuid, uuid)
  FROM PUBLIC, anon, authenticated, service_role;

-- Internal helper. Future accounting transition RPCs call this function while
-- they still own the surrounding transaction. It is deliberately not exposed
-- to PostgREST roles.
CREATE OR REPLACE FUNCTION public.record_accounting_publication(
  p_company_id uuid,
  p_publication_key text,
  p_event_type text,
  p_entity_id uuid,
  p_user_id uuid,
  p_payload jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path TO 'pg_catalog', 'public'
AS $function$
DECLARE
  v_publication public.accounting_publications%ROWTYPE;
  v_created boolean := false;
  v_inserted integer := 0;
  v_now timestamptz := pg_catalog.clock_timestamp();
  v_event_log_sequence bigint;
  v_snapshot_count integer;
  v_event_count integer;
  v_valid_event_count integer;
  v_delivery_count integer;
  v_valid_delivery_count integer;
BEGIN
  IF p_company_id IS NULL
     OR p_publication_key IS NULL
     OR length(pg_catalog.btrim(p_publication_key)) NOT BETWEEN 1 AND 512
     OR p_event_type IS NULL
     OR length(pg_catalog.btrim(p_event_type)) NOT BETWEEN 1 AND 128
     OR p_user_id IS NULL
     OR p_payload IS NULL
     OR pg_catalog.jsonb_typeof(p_payload) IS DISTINCT FROM 'object' THEN
    RAISE EXCEPTION 'Accounting publication identity and object payload are required'
      USING ERRCODE = '22023';
  END IF;

  IF p_payload ->> 'companyId' IS DISTINCT FROM p_company_id::text
     OR p_payload ->> 'userId' IS DISTINCT FROM p_user_id::text THEN
    RAISE EXCEPTION 'Accounting publication payload identity does not match its columns'
      USING ERRCODE = '22023';
  END IF;

  IF p_event_type = 'journal_entry.committed' THEN
    IF p_entity_id IS NULL
       OR p_publication_key IS DISTINCT FROM
          'journal:' || p_entity_id::text || ':committed'
       OR NOT p_payload ?& ARRAY['companyId', 'userId', 'entry']
       OR (SELECT count(*) FROM jsonb_object_keys(p_payload)) <> 3
       OR jsonb_typeof(p_payload -> 'entry') IS DISTINCT FROM 'object'
       OR p_payload -> 'entry' IS DISTINCT FROM
          public.accounting_journal_entry_event_object(p_company_id, p_entity_id)
       OR p_payload #>> '{entry,id}' IS DISTINCT FROM p_entity_id::text
       OR p_payload #>> '{entry,company_id}' IS DISTINCT FROM p_company_id::text
       OR p_payload #>> '{entry,status}' IS DISTINCT FROM 'posted' THEN
      RAISE EXCEPTION 'Committed accounting publication payload identity is invalid'
        USING ERRCODE = '22023';
    END IF;
  ELSIF p_event_type = 'journal_entry.reversed' THEN
    IF p_entity_id IS NULL
       OR NOT p_payload ?& ARRAY[
         'companyId', 'userId', 'originalEntry', 'reversalEntry'
       ]
       OR (SELECT count(*) FROM jsonb_object_keys(p_payload)) <> 4
       OR jsonb_typeof(p_payload -> 'originalEntry') IS DISTINCT FROM 'object'
       OR jsonb_typeof(p_payload -> 'reversalEntry') IS DISTINCT FROM 'object'
       OR p_publication_key IS DISTINCT FROM
          'journal:' || (p_payload #>> '{originalEntry,id}') || ':reversed'
       OR p_payload #>> '{reversalEntry,id}' IS DISTINCT FROM p_entity_id::text
       OR p_payload #>> '{originalEntry,company_id}' IS DISTINCT FROM p_company_id::text
       OR p_payload #>> '{reversalEntry,company_id}' IS DISTINCT FROM p_company_id::text
       OR p_payload #>> '{originalEntry,status}' IS DISTINCT FROM 'reversed'
       OR p_payload #>> '{originalEntry,reversed_by_id}' IS DISTINCT FROM p_entity_id::text
       OR p_payload #>> '{reversalEntry,status}' IS DISTINCT FROM 'posted'
       OR p_payload #>> '{reversalEntry,source_type}' IS DISTINCT FROM 'storno'
       OR p_payload #>> '{reversalEntry,reverses_id}' IS DISTINCT FROM
          p_payload #>> '{originalEntry,id}'
       OR p_payload -> 'originalEntry' IS DISTINCT FROM
          public.accounting_journal_entry_event_object(
            p_company_id, (p_payload #>> '{originalEntry,id}')::uuid
          )
       OR p_payload -> 'reversalEntry' IS DISTINCT FROM
          public.accounting_journal_entry_event_object(p_company_id, p_entity_id) THEN
      RAISE EXCEPTION 'Reversed accounting publication payload identity is invalid'
        USING ERRCODE = '22023';
    END IF;
  ELSE
    RAISE EXCEPTION 'Unsupported durable accounting publication event type: %', p_event_type
      USING ERRCODE = '22023';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM public.companies company
    WHERE company.id = p_company_id
  ) OR NOT EXISTS (
    SELECT 1
    FROM auth.users actor
    WHERE actor.id = p_user_id
  ) THEN
    RAISE EXCEPTION 'Accounting publication company or user identity does not exist'
      USING ERRCODE = '23503';
  END IF;

  INSERT INTO public.accounting_publications (
    company_id,
    publication_key,
    event_type,
    entity_id,
    user_id,
    payload,
    created_at
  )
  VALUES (
    p_company_id,
    p_publication_key,
    p_event_type,
    p_entity_id,
    p_user_id,
    p_payload,
    v_now
  )
  ON CONFLICT (company_id, publication_key) DO NOTHING;

  GET DIAGNOSTICS v_inserted = ROW_COUNT;
  v_created := v_inserted = 1;

  SELECT publication.*
  INTO v_publication
  FROM public.accounting_publications publication
  WHERE publication.company_id = p_company_id
    AND publication.publication_key = p_publication_key
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Accounting publication could not be locked'
      USING ERRCODE = '55000';
  END IF;

  IF v_publication.event_type IS DISTINCT FROM p_event_type
     OR v_publication.entity_id IS DISTINCT FROM p_entity_id
     OR v_publication.user_id IS DISTINCT FROM p_user_id
     OR v_publication.payload IS DISTINCT FROM p_payload THEN
    RAISE EXCEPTION 'Accounting publication key collision with different immutable content'
      USING ERRCODE = '23505';
  END IF;

  IF v_created THEN
    INSERT INTO public.accounting_publication_subscribers (
      publication_id,
      company_id,
      webhook_id,
      api_version,
      created_at
    )
    SELECT
      v_publication.id,
      p_company_id,
      subscriber.id,
      subscriber.api_version_pinned,
      v_now
    FROM (
      SELECT webhook.id, webhook.api_version_pinned
      FROM public.webhooks webhook
      WHERE webhook.company_id = p_company_id
        AND webhook.event_type = p_event_type
        AND webhook.active = true
        AND webhook.disabled_at IS NULL
      ORDER BY webhook.id
      FOR KEY SHARE
    ) subscriber;

    SELECT pg_catalog.count(*)::integer
    INTO v_snapshot_count
    FROM public.accounting_publication_subscribers subscriber
    WHERE subscriber.publication_id = v_publication.id;

    INSERT INTO public.event_log (
      user_id,
      company_id,
      event_type,
      entity_id,
      data,
      created_at,
      accounting_publication_id
    )
    VALUES (
      p_user_id,
      p_company_id,
      p_event_type,
      p_entity_id,
      (p_payload - 'userId') - 'companyId',
      v_now,
      v_publication.id
    )
    RETURNING sequence INTO v_event_log_sequence;

    INSERT INTO public.webhook_deliveries (
      webhook_id,
      company_id,
      event_type,
      payload,
      previous_attributes,
      api_version,
      status,
      attempts,
      next_attempt_at,
      request_id,
      created_at,
      accounting_publication_subscriber_id
    )
    SELECT
      subscriber.webhook_id,
      subscriber.company_id,
      p_event_type,
      p_payload - 'userId',
      NULL,
      subscriber.api_version,
      'pending',
      0,
      v_now,
      'acctpub_' || subscriber.id::text,
      v_now,
      subscriber.id
    FROM public.accounting_publication_subscribers subscriber
    WHERE subscriber.publication_id = v_publication.id
    ORDER BY subscriber.webhook_id;

    UPDATE public.accounting_publications publication
    SET
      subscriber_count = v_snapshot_count,
      event_log_sequence = v_event_log_sequence,
      published_at = v_now
    WHERE publication.id = v_publication.id
      AND publication.published_at IS NULL;

    IF NOT FOUND THEN
      RAISE EXCEPTION 'Accounting publication completion marker could not be written'
        USING ERRCODE = '55000';
    END IF;

    v_publication.subscriber_count := v_snapshot_count;
    v_publication.event_log_sequence := v_event_log_sequence;
    v_publication.published_at := v_now;
  ELSIF v_publication.published_at IS NULL
        OR v_publication.event_log_sequence IS NULL THEN
    RAISE EXCEPTION 'Accounting publication has an incomplete durable marker'
      USING ERRCODE = '55000';
  END IF;

  SELECT pg_catalog.count(*)::integer
  INTO v_snapshot_count
  FROM public.accounting_publication_subscribers subscriber
  WHERE subscriber.publication_id = v_publication.id
    AND subscriber.company_id = p_company_id;

  IF v_snapshot_count IS DISTINCT FROM v_publication.subscriber_count THEN
    RAISE EXCEPTION 'Accounting publication subscriber snapshot is incomplete or contradictory'
      USING ERRCODE = '55000';
  END IF;

  SELECT
    pg_catalog.count(*)::integer,
    pg_catalog.count(*) FILTER (
      WHERE event.sequence = v_publication.event_log_sequence
        AND event.user_id = p_user_id
        AND event.company_id = p_company_id
        AND event.event_type = p_event_type
        AND event.entity_id IS NOT DISTINCT FROM p_entity_id
        AND event.data = (p_payload - 'userId') - 'companyId'
    )::integer
  INTO v_event_count, v_valid_event_count
  FROM public.event_log event
  WHERE event.accounting_publication_id = v_publication.id;

  IF v_event_count <> 1 OR v_valid_event_count <> 1 THEN
    RAISE EXCEPTION 'Accounting publication event_log identity is missing or contradictory'
      USING ERRCODE = '55000';
  END IF;

  SELECT
    pg_catalog.count(delivery.id)::integer,
    pg_catalog.count(delivery.id) FILTER (
      WHERE delivery.company_id = subscriber.company_id
        AND delivery.event_type = p_event_type
        AND delivery.payload = p_payload - 'userId'
        AND delivery.api_version = subscriber.api_version
        AND (
          delivery.webhook_id = subscriber.webhook_id
          OR (
            delivery.webhook_id IS NULL
            AND NOT EXISTS (
              SELECT 1
              FROM public.webhooks webhook
              WHERE webhook.id = subscriber.webhook_id
            )
          )
        )
    )::integer
  INTO v_delivery_count, v_valid_delivery_count
  FROM public.accounting_publication_subscribers subscriber
  LEFT JOIN public.webhook_deliveries delivery
    ON delivery.accounting_publication_subscriber_id = subscriber.id
  WHERE subscriber.publication_id = v_publication.id;

  IF v_delivery_count IS DISTINCT FROM v_publication.subscriber_count
     OR v_valid_delivery_count IS DISTINCT FROM v_publication.subscriber_count THEN
    RAISE EXCEPTION 'Accounting publication webhook delivery snapshot is missing or contradictory'
      USING ERRCODE = '55000';
  END IF;

  RETURN pg_catalog.jsonb_build_object(
    'status', CASE WHEN v_created THEN 'published' ELSE 'already_published' END,
    'publication_id', v_publication.id,
    'publication_key', v_publication.publication_key,
    'event_log_sequence', v_publication.event_log_sequence,
    'subscriber_count', v_publication.subscriber_count,
    'webhook_delivery_count', v_delivery_count,
    'published_at', v_publication.published_at
  );
END;
$function$;

REVOKE ALL ON FUNCTION public.record_accounting_publication(
  uuid, text, text, uuid, uuid, jsonb
) FROM PUBLIC, anon, authenticated, service_role;

COMMENT ON TABLE public.accounting_publications IS
  'Deterministic durable database identity for accounting event publication. HTTP delivery is at-least-once and extension dispatch is best effort.';
COMMENT ON TABLE public.accounting_publication_subscribers IS
  'First-call webhook subscriber snapshot for a durable accounting publication. Later subscriptions are never added on retry.';
COMMENT ON FUNCTION public.record_accounting_publication(uuid, text, text, uuid, uuid, jsonb) IS
  'Internal transactional recorder for one event_log row and one webhook delivery row per first-call subscriber snapshot.';

NOTIFY pgrst, 'reload schema';
