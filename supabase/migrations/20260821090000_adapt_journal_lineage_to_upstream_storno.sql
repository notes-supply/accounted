-- Adapt the durable journal-lineage contract to the existing multi-transaction
-- storno writer without weakening permanent ledger invariants.
--
-- The historical validator required every transaction that touched lineage to
-- end in a complete final graph. Accounted publishes a draft, its lines, the
-- posted storno, the posted replacement, and the original transition through
-- separate PostgREST transactions. The permanent rules still need to reject
-- missing commit provenance and preserve a completed graph after publication.
--
-- This migration therefore keeps the deferred all-row validator, teaches it a
-- narrowly bounded staged state, and serializes child mutations through their
-- parent. A posted original may temporarily have at most one committed storno
-- and one committed correction child. Once the original is reversed, only the
-- historical complete final graph is accepted.
--
-- pg-test: covered-by tests/pg/journal-lineage-upstream-storno-adapter.pg.test.ts

DO $preflight$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM public.journal_entries entry
    WHERE entry.status IN ('posted', 'reversed')
      AND NOT public.journal_lineage_final_state_is_valid(entry.id)
  ) THEN
    RAISE EXCEPTION 'Cannot adapt journal lineage while contradictory final states exist'
      USING ERRCODE = '23514';
  END IF;
END;
$preflight$;

-- A previous unreleased draft of this migration used an immediate completion
-- trigger. Remove it so local/CI databases that exercised that draft converge
-- to the authoritative deferred design. These objects do not exist in the
-- production predecessor.
DROP TRIGGER IF EXISTS validate_journal_lineage_completion
  ON public.journal_entries;
DROP FUNCTION IF EXISTS public.validate_journal_lineage_completion();

CREATE OR REPLACE FUNCTION public.journal_lineage_state_is_valid(
  p_entry_id uuid
)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'pg_catalog', 'public'
AS $function$
  SELECT COALESCE((
    SELECT CASE
      -- Draft and cancelled rows are not committed ledger nodes. Their edge
      -- columns are still protected by validate_journal_lineage_edge().
      WHEN entry.status IN ('draft', 'cancelled') THEN true
      WHEN public.journal_lineage_final_state_is_valid(entry.id) THEN true
      -- A committed child is locally valid while its parent is still in the
      -- staged posted state. The parent is validated separately by the same
      -- deferred trigger invocation.
      WHEN entry.status = 'posted'
        AND entry.committed_at IS NOT NULL
        AND entry.reversed_by_id IS NULL
        AND entry.source_type IN ('storno', 'correction')
        AND EXISTS (
          SELECT 1
          FROM public.journal_entries parent
          WHERE parent.id = COALESCE(entry.correction_of_id, entry.reverses_id)
            AND parent.company_id = entry.company_id
            AND parent.status = 'posted'
            AND parent.committed_at IS NOT NULL
            AND parent.source_type IS DISTINCT FROM 'storno'
        )
        -- A correction may itself be corrected only after its own parent has
        -- reached a complete reversed state. This prevents a second staged
        -- generation from growing beneath an unfinished posted ancestor.
        AND NOT EXISTS (
          SELECT 1
          FROM public.journal_entries parent
          JOIN public.journal_entries ancestor
            ON ancestor.id = parent.correction_of_id
          WHERE parent.id = COALESCE(entry.correction_of_id, entry.reverses_id)
            AND parent.correction_of_id IS NOT NULL
            AND ancestor.status IS DISTINCT FROM 'reversed'
        )
        AND (
          (entry.source_type = 'storno'
           AND entry.reverses_id IS NOT NULL
           AND entry.correction_of_id IS NULL)
          OR
          (entry.source_type = 'correction'
           AND entry.correction_of_id IS NOT NULL
           AND entry.reverses_id IS NULL)
        )
        AND NOT EXISTS (
          SELECT 1
          FROM public.journal_entries child
          WHERE child.status IN ('posted', 'reversed')
            AND (
              child.correction_of_id = entry.id
              OR child.reverses_id = entry.id
            )
        )
      THEN true
      WHEN entry.status = 'posted'
        AND entry.committed_at IS NOT NULL
        AND entry.reversed_by_id IS NULL
        AND entry.source_type IS DISTINCT FROM 'storno'
        AND EXISTS (
          SELECT 1
          FROM public.journal_entries child
          WHERE child.status IN ('posted', 'reversed')
            AND (
              child.correction_of_id = entry.id
              OR child.reverses_id = entry.id
            )
        )
        AND (
          SELECT count(*)
          FROM public.journal_entries child
          WHERE child.source_type = 'correction'
            AND child.correction_of_id = entry.id
            AND child.status IN ('posted', 'reversed')
        ) <= 1
        AND (
          SELECT count(*)
          FROM public.journal_entries child
          WHERE child.source_type = 'storno'
            AND child.reverses_id = entry.id
            AND child.status IN ('posted', 'reversed')
        ) <= 1
        AND NOT EXISTS (
          SELECT 1
          FROM public.journal_entries child
          WHERE child.status IN ('posted', 'reversed')
            AND (
              child.correction_of_id = entry.id
              OR child.reverses_id = entry.id
            )
            AND (
              child.committed_at IS NULL
              OR child.company_id IS DISTINCT FROM entry.company_id
              OR child.status IS DISTINCT FROM 'posted'
              OR child.reversed_by_id IS NOT NULL
              OR (
                child.source_type = 'storno'
                AND (
                  child.reverses_id IS DISTINCT FROM entry.id
                  OR child.correction_of_id IS NOT NULL
                )
              )
              OR (
                child.source_type = 'correction'
                AND (
                  child.correction_of_id IS DISTINCT FROM entry.id
                  OR child.reverses_id IS NOT NULL
                )
              )
              OR child.source_type NOT IN ('storno', 'correction')
              OR EXISTS (
                SELECT 1
                FROM public.journal_entries grandchild
                WHERE grandchild.status IN ('posted', 'reversed')
                  AND (
                    grandchild.correction_of_id = child.id
                    OR grandchild.reverses_id = child.id
                  )
              )
            )
        )
      THEN true
      ELSE false
    END
    FROM public.journal_entries entry
    WHERE entry.id = p_entry_id
  ), true)
$function$;

REVOKE ALL ON FUNCTION public.journal_lineage_state_is_valid(uuid)
  FROM PUBLIC, anon, authenticated, service_role;

-- Child publication/cancellation and parent finalization must not form a write
-- skew. A transaction-scoped advisory lock serializes every mutation by its
-- direct lineage parent. Advisory locking is deliberate: a BEFORE UPDATE
-- trigger runs after PostgreSQL has locked the changed child row, so taking a
-- parent row lock here would invert the UUID-ordered graph locking used by the
-- supplier RPCs and create a child/parent deadlock.
CREATE OR REPLACE FUNCTION public.lock_journal_lineage_parents()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'pg_catalog', 'public'
AS $function$
DECLARE
  v_parent_ids uuid[];
  v_parent_status text;
BEGIN
  IF TG_OP = 'DELETE' THEN
    v_parent_ids := ARRAY[OLD.correction_of_id, OLD.reverses_id];
  ELSIF TG_OP = 'UPDATE' THEN
    v_parent_ids := ARRAY[
      OLD.correction_of_id, OLD.reverses_id,
      NEW.correction_of_id, NEW.reverses_id
    ];
    IF NEW.status = 'reversed' AND OLD.status IS DISTINCT FROM 'reversed' THEN
      v_parent_ids := array_append(v_parent_ids, NEW.id);
    END IF;
  ELSE
    v_parent_ids := ARRAY[NEW.correction_of_id, NEW.reverses_id];
  END IF;

  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('journal-lineage:' || lock_id::text, 0)
  )
  FROM (
    SELECT DISTINCT unnest(v_parent_ids) AS lock_id
  ) locks
  WHERE lock_id IS NOT NULL
  ORDER BY lock_id;

  -- Removing a committed correction is cleanup only while the parent is still
  -- posted. Once the parent is reversed, the correction is part of the
  -- effective final graph and must itself be reversed rather than cancelled or
  -- deleted.
  IF TG_OP IN ('UPDATE', 'DELETE')
     AND OLD.source_type = 'correction'
     AND OLD.correction_of_id IS NOT NULL
     AND OLD.status IN ('posted', 'reversed')
     AND (
       TG_OP = 'DELETE'
       OR NEW.status NOT IN ('posted', 'reversed')
     ) THEN
    SELECT parent.status
    INTO v_parent_status
    FROM public.journal_entries parent
    WHERE parent.id = OLD.correction_of_id;

    IF v_parent_status = 'reversed' THEN
      RAISE EXCEPTION 'Finalized correction child cannot be cancelled or deleted'
        USING ERRCODE = '23514';
    END IF;
  END IF;

  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$function$;

REVOKE ALL ON FUNCTION public.lock_journal_lineage_parents()
  FROM PUBLIC, anon, authenticated, service_role;

DROP TRIGGER IF EXISTS lock_journal_lineage_parents
  ON public.journal_entries;
CREATE TRIGGER lock_journal_lineage_parents
  BEFORE INSERT OR UPDATE OR DELETE ON public.journal_entries
  FOR EACH ROW
  EXECUTE FUNCTION public.lock_journal_lineage_parents();

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
       AND NOT public.journal_lineage_state_is_valid(v_entry_id) THEN
      RAISE EXCEPTION 'Journal lineage state is contradictory'
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

DROP TRIGGER IF EXISTS validate_journal_lineage_final_state
  ON public.journal_entries;
CREATE CONSTRAINT TRIGGER validate_journal_lineage_final_state
  AFTER INSERT OR UPDATE OR DELETE ON public.journal_entries
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW
  EXECUTE FUNCTION public.validate_journal_lineage_final_state();

COMMENT ON FUNCTION public.journal_lineage_final_state_is_valid(uuid) IS
  'Private diagnostic for complete journal correction graphs.';

COMMENT ON FUNCTION public.journal_lineage_state_is_valid(uuid) IS
  'Private validator for complete graphs or bounded multi-transaction staging beside a posted original.';

COMMENT ON FUNCTION public.lock_journal_lineage_parents() IS
  'Serializes lineage mutation by parent with transaction advisory locks, avoiding child/parent row-lock inversion.';
