-- Durable scheduling and WooCommerce equal-timestamp progress.
--
-- The provider data cursor remains independent from the scheduling queue:
-- claiming or rotating a connection must never imply that provider rows were
-- processed. Tokenized leases prevent overlapping crons from selecting the
-- same connection, while priority_at gives every entitled connection a turn
-- even when older connections fail permanently.

ALTER TABLE public.shopify_connections
  ADD COLUMN IF NOT EXISTS order_sync_priority_at timestamptz,
  ADD COLUMN IF NOT EXISTS order_sync_claim_token uuid,
  ADD COLUMN IF NOT EXISTS order_sync_claimed_until timestamptz,
  ADD COLUMN IF NOT EXISTS order_sync_scan_min_updated_at timestamptz,
  ADD COLUMN IF NOT EXISTS order_sync_scan_min_inclusive boolean NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS order_sync_scan_max_updated_at timestamptz,
  ADD COLUMN IF NOT EXISTS order_sync_scan_cohort_updated_at timestamptz,
  ADD COLUMN IF NOT EXISTS order_sync_scan_after text,
  ADD COLUMN IF NOT EXISTS order_sync_scan_pass_found_new boolean NOT NULL DEFAULT false;

UPDATE public.shopify_connections
SET order_sync_priority_at = CASE
  WHEN last_order_synced_at IS NULL
    THEN '1970-01-01 00:00:00+00'::timestamptz
  ELSE LEAST(last_order_synced_at, pg_catalog.clock_timestamp())
END
WHERE order_sync_priority_at IS NULL;

ALTER TABLE public.shopify_connections
  ALTER COLUMN order_sync_priority_at
    SET DEFAULT '1970-01-01 00:00:00+00'::timestamptz,
  ALTER COLUMN order_sync_priority_at SET NOT NULL;

ALTER TABLE public.shopify_connections
  DROP CONSTRAINT IF EXISTS shopify_order_sync_scan_consistent,
  ADD CONSTRAINT shopify_order_sync_scan_consistent CHECK (
    (order_sync_scan_max_updated_at IS NULL
      AND order_sync_scan_min_updated_at IS NULL
      AND order_sync_scan_cohort_updated_at IS NULL
      AND order_sync_scan_after IS NULL
      AND order_sync_scan_min_inclusive = true
      AND order_sync_scan_pass_found_new = false)
    OR
    (order_sync_scan_max_updated_at IS NOT NULL
      AND order_sync_scan_min_updated_at IS NOT NULL
      AND order_sync_scan_min_updated_at <= order_sync_scan_max_updated_at
      AND (order_sync_scan_after IS NULL
        OR order_sync_scan_cohort_updated_at IS NOT NULL))
  );

ALTER TABLE public.woocommerce_connections
  ADD COLUMN IF NOT EXISTS order_sync_priority_at timestamptz,
  ADD COLUMN IF NOT EXISTS order_sync_claim_token uuid,
  ADD COLUMN IF NOT EXISTS order_sync_claimed_until timestamptz,
  ADD COLUMN IF NOT EXISTS order_sync_scan_modified_after timestamptz,
  ADD COLUMN IF NOT EXISTS order_sync_cohort_modified_at timestamptz,
  ADD COLUMN IF NOT EXISTS order_sync_cohort_page integer NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS order_sync_cohort_pass_found_new boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS order_sync_cohort_expected_total integer,
  ADD COLUMN IF NOT EXISTS order_sync_cohort_expected_pages integer,
  ADD COLUMN IF NOT EXISTS order_sync_cohort_pass_seen_count integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS order_sync_cohort_pass_last_order_id bigint;

UPDATE public.woocommerce_connections
SET order_sync_priority_at = CASE
  WHEN last_order_synced_at IS NULL
    THEN '1970-01-01 00:00:00+00'::timestamptz
  ELSE LEAST(last_order_synced_at, pg_catalog.clock_timestamp())
END
WHERE order_sync_priority_at IS NULL;

ALTER TABLE public.woocommerce_connections
  ALTER COLUMN order_sync_priority_at
    SET DEFAULT '1970-01-01 00:00:00+00'::timestamptz,
  ALTER COLUMN order_sync_priority_at SET NOT NULL;

ALTER TABLE public.woocommerce_connections
  DROP CONSTRAINT IF EXISTS woocommerce_order_sync_cohort_page_positive,
  ADD CONSTRAINT woocommerce_order_sync_cohort_page_positive
    CHECK (order_sync_cohort_page >= 1),
  DROP CONSTRAINT IF EXISTS woocommerce_order_sync_snapshot_consistent,
  ADD CONSTRAINT woocommerce_order_sync_snapshot_consistent CHECK (
    order_sync_cohort_pass_seen_count >= 0
    AND (order_sync_cohort_expected_total IS NULL
      OR order_sync_cohort_expected_total BETWEEN 0 AND 100000)
    AND (order_sync_cohort_expected_pages IS NULL
      OR order_sync_cohort_expected_pages >= 0)
    AND ((order_sync_cohort_expected_total IS NULL
        AND order_sync_cohort_expected_pages IS NULL
        AND order_sync_cohort_pass_seen_count = 0
        AND order_sync_cohort_pass_last_order_id IS NULL)
      OR (order_sync_cohort_modified_at IS NOT NULL
        AND order_sync_cohort_expected_total IS NOT NULL
        AND order_sync_cohort_expected_pages IS NOT NULL))
  );

CREATE INDEX IF NOT EXISTS idx_shopify_connections_order_sync_queue
  ON public.shopify_connections (order_sync_priority_at, id)
  WHERE status = 'active' AND transaction_sync_enabled = true;

CREATE INDEX IF NOT EXISTS idx_woocommerce_connections_order_sync_queue
  ON public.woocommerce_connections (order_sync_priority_at, id)
  WHERE status = 'active' AND transaction_sync_enabled = true;

-- One row means that one order in the exact modified-at cohort completed all
-- ingestion and refund work. The sync writes a marker only after processing,
-- so a crash can cause harmless replay but cannot cause a skipped order.
CREATE TABLE IF NOT EXISTS public.woocommerce_order_sync_seen (
  connection_id uuid NOT NULL
    REFERENCES public.woocommerce_connections(id) ON DELETE CASCADE,
  modified_at timestamptz NOT NULL,
  order_id bigint NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (connection_id, modified_at, order_id)
);

CREATE TABLE IF NOT EXISTS public.shopify_order_sync_seen (
  connection_id uuid NOT NULL
    REFERENCES public.shopify_connections(id) ON DELETE CASCADE,
  updated_at timestamptz NOT NULL,
  order_id text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (connection_id, updated_at, order_id)
);

CREATE TABLE IF NOT EXISTS public.woocommerce_order_sync_marker_counts (
  connection_id uuid PRIMARY KEY
    REFERENCES public.woocommerce_connections(id) ON DELETE CASCADE,
  marker_count integer NOT NULL DEFAULT 0
    CHECK (marker_count BETWEEN 0 AND 100000)
);

CREATE TABLE IF NOT EXISTS public.shopify_order_sync_marker_counts (
  connection_id uuid PRIMARY KEY
    REFERENCES public.shopify_connections(id) ON DELETE CASCADE,
  marker_count integer NOT NULL DEFAULT 0
    CHECK (marker_count BETWEEN 0 AND 100000)
);

CREATE TABLE IF NOT EXISTS public.commerce_order_sync_claim_cancellations (
  provider text NOT NULL CHECK (provider IN ('shopify', 'woocommerce')),
  connection_id uuid NOT NULL,
  claim_token uuid NOT NULL,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT pg_catalog.clock_timestamp(),
  PRIMARY KEY (provider, connection_id, claim_token)
);

CREATE INDEX IF NOT EXISTS idx_commerce_claim_cancellations_expiry
  ON public.commerce_order_sync_claim_cancellations (expires_at);

ALTER TABLE public.woocommerce_order_sync_seen ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.shopify_order_sync_seen ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.woocommerce_order_sync_marker_counts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.shopify_order_sync_marker_counts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.commerce_order_sync_claim_cancellations ENABLE ROW LEVEL SECURITY;

COMMENT ON TABLE public.woocommerce_order_sync_seen IS
  'Service-only completion markers for restart-safe WooCommerce modified-at cohort sweeps.';
COMMENT ON TABLE public.shopify_order_sync_seen IS
  'Service-only completion markers for restart-safe Shopify updatedAt cohort sweeps.';
COMMENT ON TABLE public.woocommerce_order_sync_marker_counts IS
  'Service-only bounded marker counts for WooCommerce order sync.';
COMMENT ON TABLE public.shopify_order_sync_marker_counts IS
  'Service-only bounded marker counts for Shopify order sync.';
COMMENT ON TABLE public.commerce_order_sync_claim_cancellations IS
  'Service-only tombstones that serialize timed-out claims with exact-token cancellation.';

-- A single provider timestamp cohort may legitimately exceed 10,000 orders,
-- but operational markers must not grow without limit. 100,000 markers per
-- connection leaves a 10x margin over the required cohort and also bounds
-- orphan markers left by any crash before a cohort transition. The marker is
-- never silently dropped and provider progress cannot advance on this error.
CREATE OR REPLACE FUNCTION public.enforce_commerce_sync_marker_bound()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $$
DECLARE
  v_connection_id uuid;
  v_inserted integer;
  v_marker_count integer;
  v_scope text;
BEGIN
  IF TG_TABLE_SCHEMA <> 'public'
      OR TG_TABLE_NAME NOT IN (
        'shopify_order_sync_seen',
        'woocommerce_order_sync_seen'
      ) THEN
    RAISE EXCEPTION 'unsupported commerce marker table'
      USING ERRCODE = '22023';
  END IF;

  FOR v_connection_id, v_inserted IN
    SELECT connection_id, pg_catalog.count(*)::integer
    FROM inserted_rows
    GROUP BY connection_id
    ORDER BY connection_id
  LOOP
    v_scope := TG_TABLE_NAME || ':' || v_connection_id::text;
    PERFORM pg_catalog.pg_advisory_xact_lock(
      pg_catalog.hashtextextended(v_scope, 0)
    );
    v_marker_count := NULL;

    IF v_inserted > 100000 THEN
      RAISE EXCEPTION 'commerce order sync marker limit exceeded'
        USING ERRCODE = '54000';
    END IF;

    IF TG_TABLE_NAME = 'woocommerce_order_sync_seen' THEN
      INSERT INTO public.woocommerce_order_sync_marker_counts AS marker_counts (
        connection_id,
        marker_count
      ) VALUES (
        v_connection_id,
        v_inserted
      )
      ON CONFLICT (connection_id) DO UPDATE
      SET marker_count = marker_counts.marker_count + EXCLUDED.marker_count
      WHERE marker_counts.marker_count <= 100000 - EXCLUDED.marker_count
      RETURNING marker_count INTO v_marker_count;
    ELSE
      INSERT INTO public.shopify_order_sync_marker_counts AS marker_counts (
        connection_id,
        marker_count
      ) VALUES (
        v_connection_id,
        v_inserted
      )
      ON CONFLICT (connection_id) DO UPDATE
      SET marker_count = marker_counts.marker_count + EXCLUDED.marker_count
      WHERE marker_counts.marker_count <= 100000 - EXCLUDED.marker_count
      RETURNING marker_count INTO v_marker_count;
    END IF;

    IF v_marker_count IS NULL THEN
      RAISE EXCEPTION 'commerce order sync marker limit exceeded'
        USING ERRCODE = '54000';
    END IF;
  END LOOP;
  RETURN NULL;
END;
$$;

CREATE OR REPLACE FUNCTION public.decrement_commerce_sync_marker_count()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $$
DECLARE
  v_connection_id uuid;
  v_deleted integer;
  v_changed bigint;
  v_scope text;
BEGIN
  IF TG_TABLE_SCHEMA <> 'public'
      OR TG_TABLE_NAME NOT IN (
        'shopify_order_sync_seen',
        'woocommerce_order_sync_seen'
      ) THEN
    RAISE EXCEPTION 'unsupported commerce marker table'
      USING ERRCODE = '22023';
  END IF;

  FOR v_connection_id, v_deleted IN
    SELECT connection_id, pg_catalog.count(*)::integer
    FROM deleted_rows
    GROUP BY connection_id
    ORDER BY connection_id
  LOOP
    v_scope := TG_TABLE_NAME || ':' || v_connection_id::text;
    PERFORM pg_catalog.pg_advisory_xact_lock(
      pg_catalog.hashtextextended(v_scope, 0)
    );

    IF TG_TABLE_NAME = 'woocommerce_order_sync_seen' THEN
      UPDATE public.woocommerce_order_sync_marker_counts
      SET marker_count = marker_count - v_deleted
      WHERE connection_id = v_connection_id
        AND marker_count >= v_deleted;
      GET DIAGNOSTICS v_changed = ROW_COUNT;
      IF v_changed = 0 AND EXISTS (
        SELECT 1 FROM public.woocommerce_connections
        WHERE id = v_connection_id
      ) THEN
        RAISE EXCEPTION 'commerce order sync marker count is inconsistent'
          USING ERRCODE = '55000';
      END IF;
    ELSE
      UPDATE public.shopify_order_sync_marker_counts
      SET marker_count = marker_count - v_deleted
      WHERE connection_id = v_connection_id
        AND marker_count >= v_deleted;
      GET DIAGNOSTICS v_changed = ROW_COUNT;
      IF v_changed = 0 AND EXISTS (
        SELECT 1 FROM public.shopify_connections
        WHERE id = v_connection_id
      ) THEN
        RAISE EXCEPTION 'commerce order sync marker count is inconsistent'
          USING ERRCODE = '55000';
      END IF;
    END IF;
  END LOOP;
  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS enforce_woocommerce_sync_marker_bound
  ON public.woocommerce_order_sync_seen;
CREATE TRIGGER enforce_woocommerce_sync_marker_bound
  AFTER INSERT ON public.woocommerce_order_sync_seen
  REFERENCING NEW TABLE AS inserted_rows
  FOR EACH STATEMENT EXECUTE FUNCTION public.enforce_commerce_sync_marker_bound();

DROP TRIGGER IF EXISTS enforce_shopify_sync_marker_bound
  ON public.shopify_order_sync_seen;
CREATE TRIGGER enforce_shopify_sync_marker_bound
  AFTER INSERT ON public.shopify_order_sync_seen
  REFERENCING NEW TABLE AS inserted_rows
  FOR EACH STATEMENT EXECUTE FUNCTION public.enforce_commerce_sync_marker_bound();

DROP TRIGGER IF EXISTS decrement_woocommerce_sync_marker_count
  ON public.woocommerce_order_sync_seen;
CREATE TRIGGER decrement_woocommerce_sync_marker_count
  AFTER DELETE ON public.woocommerce_order_sync_seen
  REFERENCING OLD TABLE AS deleted_rows
  FOR EACH STATEMENT EXECUTE FUNCTION public.decrement_commerce_sync_marker_count();

DROP TRIGGER IF EXISTS decrement_shopify_sync_marker_count
  ON public.shopify_order_sync_seen;
CREATE TRIGGER decrement_shopify_sync_marker_count
  AFTER DELETE ON public.shopify_order_sync_seen
  REFERENCING OLD TABLE AS deleted_rows
  FOR EACH STATEMENT EXECUTE FUNCTION public.decrement_commerce_sync_marker_count();

CREATE OR REPLACE FUNCTION public.checkpoint_shopify_order_sync(
  p_connection_id uuid,
  p_claim_token uuid,
  p_scan_min_updated_at timestamptz,
  p_scan_min_inclusive boolean,
  p_scan_max_updated_at timestamptz,
  p_cohort_updated_at timestamptz,
  p_after text,
  p_pass_found_new boolean,
  p_completed_order_ids text[]
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $$
DECLARE
  v_previous_cohort timestamptz;
  v_previous_max timestamptz;
BEGIN
  SELECT order_sync_scan_cohort_updated_at, order_sync_scan_max_updated_at
  INTO v_previous_cohort, v_previous_max
  FROM public.shopify_connections
  WHERE id = p_connection_id
    AND status = 'active'
    AND order_sync_claim_token = p_claim_token
    AND order_sync_claimed_until > pg_catalog.clock_timestamp()
  FOR UPDATE;
  IF NOT FOUND THEN RETURN false; END IF;

  IF v_previous_max IS NOT NULL
      AND v_previous_max IS DISTINCT FROM p_scan_max_updated_at THEN
    RAISE EXCEPTION 'shopify sync query identity changed'
      USING ERRCODE = '40001';
  END IF;

  IF v_previous_cohort IS DISTINCT FROM p_cohort_updated_at THEN
    DELETE FROM public.shopify_order_sync_seen
    WHERE connection_id = p_connection_id;
  END IF;

  INSERT INTO public.shopify_order_sync_seen(connection_id, updated_at, order_id)
  SELECT p_connection_id, p_cohort_updated_at, order_id
  FROM pg_catalog.unnest(p_completed_order_ids) AS order_id
  ON CONFLICT DO NOTHING;

  UPDATE public.shopify_connections
  SET order_sync_scan_min_updated_at = p_scan_min_updated_at,
      order_sync_scan_min_inclusive = p_scan_min_inclusive,
      order_sync_scan_max_updated_at = p_scan_max_updated_at,
      order_sync_scan_cohort_updated_at = p_cohort_updated_at,
      order_sync_scan_after = p_after,
      order_sync_scan_pass_found_new = p_pass_found_new,
      error_message = NULL
  WHERE id = p_connection_id;
  RETURN true;
END;
$$;

CREATE OR REPLACE FUNCTION public.complete_shopify_order_sync_cohort(
  p_connection_id uuid,
  p_claim_token uuid,
  p_cohort_updated_at timestamptz
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $$
BEGIN
  UPDATE public.shopify_connections
  SET order_sync_scan_min_updated_at = p_cohort_updated_at,
      order_sync_scan_min_inclusive = false,
      order_sync_scan_cohort_updated_at = NULL,
      order_sync_scan_after = NULL,
      order_sync_scan_pass_found_new = false,
      error_message = NULL
  WHERE id = p_connection_id
    AND status = 'active'
    AND order_sync_claim_token = p_claim_token
    AND order_sync_claimed_until > pg_catalog.clock_timestamp()
    AND order_sync_scan_cohort_updated_at = p_cohort_updated_at;
  IF NOT FOUND THEN RETURN false; END IF;

  DELETE FROM public.shopify_order_sync_seen
  WHERE connection_id = p_connection_id;
  RETURN true;
END;
$$;

CREATE OR REPLACE FUNCTION public.complete_shopify_order_sync(
  p_connection_id uuid,
  p_claim_token uuid,
  p_scan_max_updated_at timestamptz
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $$
BEGIN
  PERFORM 1 FROM public.shopify_connections
  WHERE id = p_connection_id
    AND status = 'active'
    AND order_sync_claim_token = p_claim_token
    AND order_sync_claimed_until > pg_catalog.clock_timestamp()
  FOR UPDATE;
  IF NOT FOUND THEN RETURN false; END IF;

  UPDATE public.shopify_connections
  SET last_order_synced_at = p_scan_max_updated_at,
      order_sync_scan_min_updated_at = NULL,
      order_sync_scan_min_inclusive = true,
      order_sync_scan_max_updated_at = NULL,
      order_sync_scan_cohort_updated_at = NULL,
      order_sync_scan_after = NULL,
      order_sync_scan_pass_found_new = false,
      error_message = NULL
  WHERE id = p_connection_id;
  DELETE FROM public.shopify_order_sync_seen
  WHERE connection_id = p_connection_id;
  RETURN true;
END;
$$;

CREATE OR REPLACE FUNCTION public.start_woocommerce_order_sync_cohort(
  p_connection_id uuid,
  p_claim_token uuid,
  p_scan_modified_after timestamptz,
  p_modified_at timestamptz,
  p_order_ids bigint[],
  p_last_order_synced_at timestamptz
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $$
BEGIN
  PERFORM 1 FROM public.woocommerce_connections
  WHERE id = p_connection_id
    AND status = 'active'
    AND order_sync_claim_token = p_claim_token
    AND order_sync_claimed_until > pg_catalog.clock_timestamp()
  FOR UPDATE;
  IF NOT FOUND THEN RETURN false; END IF;

  DELETE FROM public.woocommerce_order_sync_seen
  WHERE connection_id = p_connection_id
    AND modified_at IS DISTINCT FROM p_modified_at;
  INSERT INTO public.woocommerce_order_sync_seen(connection_id, modified_at, order_id)
  SELECT p_connection_id, p_modified_at, order_id
  FROM pg_catalog.unnest(p_order_ids) AS order_id
  ON CONFLICT DO NOTHING;
  UPDATE public.woocommerce_connections
  SET last_order_synced_at = COALESCE(p_last_order_synced_at, last_order_synced_at),
      order_sync_scan_modified_after = p_scan_modified_after,
      order_sync_cohort_modified_at = p_modified_at,
      order_sync_cohort_page = 1,
      order_sync_cohort_pass_found_new = false,
      order_sync_cohort_expected_total = NULL,
      order_sync_cohort_expected_pages = NULL,
      order_sync_cohort_pass_seen_count = 0,
      order_sync_cohort_pass_last_order_id = NULL,
      error_message = NULL
  WHERE id = p_connection_id;
  RETURN true;
END;
$$;

CREATE OR REPLACE FUNCTION public.record_woocommerce_order_sync_seen(
  p_connection_id uuid,
  p_claim_token uuid,
  p_modified_at timestamptz,
  p_order_ids bigint[]
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $$
BEGIN
  PERFORM 1 FROM public.woocommerce_connections
  WHERE id = p_connection_id
    AND status = 'active'
    AND order_sync_claim_token = p_claim_token
    AND order_sync_claimed_until > pg_catalog.clock_timestamp()
    AND order_sync_cohort_modified_at = p_modified_at
  FOR UPDATE;
  IF NOT FOUND THEN RETURN false; END IF;

  INSERT INTO public.woocommerce_order_sync_seen(connection_id, modified_at, order_id)
  SELECT p_connection_id, p_modified_at, order_id
  FROM pg_catalog.unnest(p_order_ids) AS order_id
  ON CONFLICT DO NOTHING;
  RETURN true;
END;
$$;

CREATE OR REPLACE FUNCTION public.checkpoint_woocommerce_order_sync(
  p_connection_id uuid,
  p_claim_token uuid,
  p_scan_modified_after timestamptz,
  p_modified_at timestamptz,
  p_page integer,
  p_pass_found_new boolean,
  p_expected_total integer,
  p_expected_pages integer,
  p_pass_seen_count integer,
  p_pass_last_order_id bigint,
  p_completed_order_ids bigint[]
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $$
DECLARE
  v_current_cohort timestamptz;
BEGIN
  SELECT order_sync_cohort_modified_at
  INTO v_current_cohort
  FROM public.woocommerce_connections
  WHERE id = p_connection_id
    AND status = 'active'
    AND order_sync_claim_token = p_claim_token
    AND order_sync_claimed_until > pg_catalog.clock_timestamp()
    AND order_sync_cohort_modified_at = p_modified_at
  FOR UPDATE;
  IF NOT FOUND OR v_current_cohort IS DISTINCT FROM p_modified_at THEN
    RETURN false;
  END IF;
  IF p_expected_total IS NOT NULL AND p_expected_total > 100000 THEN
    RAISE EXCEPTION 'commerce order sync marker limit exceeded'
      USING ERRCODE = '54000';
  END IF;

  INSERT INTO public.woocommerce_order_sync_seen(connection_id, modified_at, order_id)
  SELECT p_connection_id, p_modified_at, order_id
  FROM pg_catalog.unnest(p_completed_order_ids) AS order_id
  ON CONFLICT DO NOTHING;

  UPDATE public.woocommerce_connections
  SET order_sync_scan_modified_after = p_scan_modified_after,
      order_sync_cohort_page = p_page,
      order_sync_cohort_pass_found_new = p_pass_found_new,
      order_sync_cohort_expected_total = p_expected_total,
      order_sync_cohort_expected_pages = p_expected_pages,
      order_sync_cohort_pass_seen_count = p_pass_seen_count,
      order_sync_cohort_pass_last_order_id = p_pass_last_order_id,
      error_message = NULL
  WHERE id = p_connection_id;
  RETURN true;
END;
$$;

CREATE OR REPLACE FUNCTION public.complete_woocommerce_order_sync_cohort(
  p_connection_id uuid,
  p_claim_token uuid,
  p_modified_at timestamptz,
  p_last_order_synced_at timestamptz
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $$
BEGIN
  PERFORM 1 FROM public.woocommerce_connections
  WHERE id = p_connection_id
    AND status = 'active'
    AND order_sync_claim_token = p_claim_token
    AND order_sync_claimed_until > pg_catalog.clock_timestamp()
    AND order_sync_cohort_modified_at = p_modified_at
  FOR UPDATE;
  IF NOT FOUND THEN RETURN false; END IF;

  UPDATE public.woocommerce_connections
  SET last_order_synced_at = COALESCE(
        p_last_order_synced_at,
        last_order_synced_at
      ),
      order_sync_scan_modified_after = p_modified_at,
      order_sync_cohort_modified_at = NULL,
      order_sync_cohort_page = 1,
      order_sync_cohort_pass_found_new = false,
      order_sync_cohort_expected_total = NULL,
      order_sync_cohort_expected_pages = NULL,
      order_sync_cohort_pass_seen_count = 0,
      order_sync_cohort_pass_last_order_id = NULL,
      error_message = NULL
  WHERE id = p_connection_id;
  DELETE FROM public.woocommerce_order_sync_seen
  WHERE connection_id = p_connection_id
    AND modified_at = p_modified_at;
  RETURN true;
END;
$$;

CREATE OR REPLACE FUNCTION public.complete_woocommerce_order_sync(
  p_connection_id uuid,
  p_claim_token uuid,
  p_last_order_synced_at timestamptz
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $$
BEGIN
  UPDATE public.woocommerce_connections
  SET last_order_synced_at = p_last_order_synced_at,
      order_sync_scan_modified_after = NULL,
      order_sync_cohort_modified_at = NULL,
      order_sync_cohort_page = 1,
      order_sync_cohort_pass_found_new = false,
      order_sync_cohort_expected_total = NULL,
      order_sync_cohort_expected_pages = NULL,
      order_sync_cohort_pass_seen_count = 0,
      order_sync_cohort_pass_last_order_id = NULL,
      error_message = NULL
  WHERE id = p_connection_id
    AND status = 'active'
    AND order_sync_claim_token = p_claim_token
    AND order_sync_claimed_until > pg_catalog.clock_timestamp()
    AND order_sync_cohort_modified_at IS NULL;
  RETURN FOUND;
END;
$$;

-- Queue lifecycle RPCs use a fixed provider allowlist instead of dynamic SQL.
-- The client chooses the opaque token before I/O, so an ambiguous timeout can
-- only restore the exact lease that invocation may have acquired.
CREATE OR REPLACE FUNCTION public.claim_commerce_order_sync_connection(
  p_provider text,
  p_connection_id uuid,
  p_expected_priority_at timestamptz,
  p_claim_token uuid,
  p_claimed_at timestamptz,
  p_claimed_until timestamptz,
  p_require_sync_enabled boolean
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $$
DECLARE
  v_changed bigint;
BEGIN
  IF p_provider NOT IN ('shopify', 'woocommerce') THEN
    RAISE EXCEPTION 'unsupported commerce provider'
      USING ERRCODE = '22023';
  END IF;
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
    'commerce-claim:' || p_provider || ':' || p_connection_id::text,
    0
  ));
  DELETE FROM public.commerce_order_sync_claim_cancellations
  WHERE provider = p_provider
    AND connection_id = p_connection_id
    AND claim_token = p_claim_token
    AND expires_at <= pg_catalog.clock_timestamp();
  IF EXISTS (
    SELECT 1 FROM public.commerce_order_sync_claim_cancellations
    WHERE provider = p_provider
      AND connection_id = p_connection_id
      AND claim_token = p_claim_token
      AND expires_at > pg_catalog.clock_timestamp()
  ) THEN
    RETURN false;
  END IF;

  IF p_provider = 'shopify' THEN
    UPDATE public.shopify_connections
    SET order_sync_priority_at = p_claimed_at,
        order_sync_claim_token = p_claim_token,
        order_sync_claimed_until = p_claimed_until
    WHERE id = p_connection_id
      AND status = 'active'
      AND order_sync_priority_at = p_expected_priority_at
      AND (NOT p_require_sync_enabled OR transaction_sync_enabled = true)
      AND (order_sync_claimed_until IS NULL
        OR order_sync_claimed_until < p_claimed_at);
  ELSIF p_provider = 'woocommerce' THEN
    UPDATE public.woocommerce_connections
    SET order_sync_priority_at = p_claimed_at,
        order_sync_claim_token = p_claim_token,
        order_sync_claimed_until = p_claimed_until
    WHERE id = p_connection_id
      AND status = 'active'
      AND order_sync_priority_at = p_expected_priority_at
      AND (NOT p_require_sync_enabled OR transaction_sync_enabled = true)
      AND (order_sync_claimed_until IS NULL
        OR order_sync_claimed_until < p_claimed_at);
  END IF;
  GET DIAGNOSTICS v_changed = ROW_COUNT;
  RETURN v_changed = 1;
END;
$$;

CREATE OR REPLACE FUNCTION public.release_commerce_order_sync_claim(
  p_provider text,
  p_connection_id uuid,
  p_claim_token uuid
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $$
DECLARE
  v_token uuid;
BEGIN
  IF p_provider NOT IN ('shopify', 'woocommerce') THEN
    RAISE EXCEPTION 'unsupported commerce provider'
      USING ERRCODE = '22023';
  END IF;
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
    'commerce-claim:' || p_provider || ':' || p_connection_id::text,
    0
  ));
  IF p_provider = 'shopify' THEN
    SELECT order_sync_claim_token INTO v_token
    FROM public.shopify_connections WHERE id = p_connection_id FOR UPDATE;
    IF NOT FOUND THEN RETURN false; END IF;
    IF v_token IS NULL THEN RETURN true; END IF;
    IF v_token IS DISTINCT FROM p_claim_token THEN RETURN false; END IF;
    UPDATE public.shopify_connections
    SET order_sync_claim_token = NULL,
        order_sync_claimed_until = NULL
    WHERE id = p_connection_id
      AND order_sync_claim_token = p_claim_token;
  ELSIF p_provider = 'woocommerce' THEN
    SELECT order_sync_claim_token INTO v_token
    FROM public.woocommerce_connections WHERE id = p_connection_id FOR UPDATE;
    IF NOT FOUND THEN RETURN false; END IF;
    IF v_token IS NULL THEN RETURN true; END IF;
    IF v_token IS DISTINCT FROM p_claim_token THEN RETURN false; END IF;
    UPDATE public.woocommerce_connections
    SET order_sync_claim_token = NULL,
        order_sync_claimed_until = NULL
    WHERE id = p_connection_id
      AND order_sync_claim_token = p_claim_token;
  END IF;
  RETURN true;
END;
$$;

CREATE OR REPLACE FUNCTION public.restore_commerce_order_sync_claim(
  p_provider text,
  p_connection_id uuid,
  p_claim_token uuid,
  p_previous_priority_at timestamptz
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $$
DECLARE
  v_token uuid;
BEGIN
  IF p_provider NOT IN ('shopify', 'woocommerce') THEN
    RAISE EXCEPTION 'unsupported commerce provider'
      USING ERRCODE = '22023';
  END IF;
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
    'commerce-claim:' || p_provider || ':' || p_connection_id::text,
    0
  ));

  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
    'commerce-claim-cancellation-bound',
    0
  ));
  DELETE FROM public.commerce_order_sync_claim_cancellations
  WHERE ctid IN (
    SELECT ctid FROM public.commerce_order_sync_claim_cancellations
    WHERE expires_at <= pg_catalog.clock_timestamp()
    ORDER BY expires_at
    LIMIT 1000
  );
  IF (SELECT pg_catalog.count(*) FROM public.commerce_order_sync_claim_cancellations) >= 100000
      AND NOT EXISTS (
        SELECT 1 FROM public.commerce_order_sync_claim_cancellations
        WHERE provider = p_provider
          AND connection_id = p_connection_id
          AND claim_token = p_claim_token
      ) THEN
    RAISE EXCEPTION 'commerce claim cancellation limit exceeded'
      USING ERRCODE = '54000';
  END IF;
  INSERT INTO public.commerce_order_sync_claim_cancellations(
    provider, connection_id, claim_token, expires_at
  ) VALUES (
    p_provider, p_connection_id, p_claim_token,
    pg_catalog.clock_timestamp() + interval '1 hour'
  )
  ON CONFLICT (provider, connection_id, claim_token) DO UPDATE
  SET expires_at = EXCLUDED.expires_at;

  IF p_provider = 'shopify' THEN
    SELECT order_sync_claim_token INTO v_token
    FROM public.shopify_connections WHERE id = p_connection_id FOR UPDATE;
    IF NOT FOUND THEN RETURN false; END IF;
    IF v_token IS NULL THEN RETURN true; END IF;
    IF v_token IS DISTINCT FROM p_claim_token THEN RETURN false; END IF;
    UPDATE public.shopify_connections
    SET order_sync_priority_at = p_previous_priority_at,
        order_sync_claim_token = NULL,
        order_sync_claimed_until = NULL
    WHERE id = p_connection_id
      AND status = 'active'
      AND order_sync_claim_token = p_claim_token;
  ELSIF p_provider = 'woocommerce' THEN
    SELECT order_sync_claim_token INTO v_token
    FROM public.woocommerce_connections WHERE id = p_connection_id FOR UPDATE;
    IF NOT FOUND THEN RETURN false; END IF;
    IF v_token IS NULL THEN RETURN true; END IF;
    IF v_token IS DISTINCT FROM p_claim_token THEN RETURN false; END IF;
    UPDATE public.woocommerce_connections
    SET order_sync_priority_at = p_previous_priority_at,
        order_sync_claim_token = NULL,
        order_sync_claimed_until = NULL
    WHERE id = p_connection_id
      AND status = 'active'
      AND order_sync_claim_token = p_claim_token;
  END IF;
  RETURN true;
END;
$$;

CREATE OR REPLACE FUNCTION public.rotate_ineligible_commerce_order_sync_connection(
  p_provider text,
  p_connection_id uuid,
  p_expected_priority_at timestamptz,
  p_rotated_at timestamptz
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $$
BEGIN
  IF p_provider = 'shopify' THEN
    UPDATE public.shopify_connections
    SET order_sync_priority_at = p_rotated_at
    WHERE id = p_connection_id
      AND status = 'active'
      AND transaction_sync_enabled = true
      AND order_sync_priority_at = p_expected_priority_at;
  ELSIF p_provider = 'woocommerce' THEN
    UPDATE public.woocommerce_connections
    SET order_sync_priority_at = p_rotated_at
    WHERE id = p_connection_id
      AND status = 'active'
      AND transaction_sync_enabled = true
      AND order_sync_priority_at = p_expected_priority_at;
  ELSE
    RAISE EXCEPTION 'unsupported commerce provider'
      USING ERRCODE = '22023';
  END IF;
  RETURN FOUND;
END;
$$;

CREATE OR REPLACE FUNCTION public.disconnect_commerce_connection(
  p_provider text,
  p_connection_id uuid,
  p_company_id uuid,
  p_disconnected_at timestamptz
)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_claimed_until timestamptz;
BEGIN
  IF auth.role() IS DISTINCT FROM 'service_role'
      AND NOT public.caller_can_write_company(p_company_id) THEN
    RETURN 'not_found';
  END IF;

  IF p_provider = 'shopify' THEN
    SELECT order_sync_claimed_until INTO v_claimed_until
    FROM public.shopify_connections
    WHERE id = p_connection_id AND company_id = p_company_id
    FOR UPDATE;
    IF NOT FOUND THEN RETURN 'not_found'; END IF;
    IF v_claimed_until IS NOT NULL AND v_claimed_until > pg_catalog.clock_timestamp() THEN
      RETURN 'conflict';
    END IF;
    UPDATE public.shopify_connections
    SET status = 'revoked',
        client_id_encrypted = NULL,
        client_secret_encrypted = NULL,
        disconnected_at = p_disconnected_at,
        order_sync_scan_min_updated_at = NULL,
        order_sync_scan_min_inclusive = true,
        order_sync_scan_max_updated_at = NULL,
        order_sync_scan_cohort_updated_at = NULL,
        order_sync_scan_after = NULL,
        order_sync_scan_pass_found_new = false,
        last_order_synced_at = NULL,
        order_sync_priority_at = '1970-01-01 00:00:00+00'::timestamptz,
        order_sync_claim_token = NULL,
        order_sync_claimed_until = NULL
    WHERE id = p_connection_id;
    DELETE FROM public.shopify_order_sync_seen WHERE connection_id = p_connection_id;
    DELETE FROM public.commerce_order_sync_claim_cancellations
    WHERE provider = 'shopify' AND connection_id = p_connection_id;
  ELSIF p_provider = 'woocommerce' THEN
    SELECT order_sync_claimed_until INTO v_claimed_until
    FROM public.woocommerce_connections
    WHERE id = p_connection_id AND company_id = p_company_id
    FOR UPDATE;
    IF NOT FOUND THEN RETURN 'not_found'; END IF;
    IF v_claimed_until IS NOT NULL AND v_claimed_until > pg_catalog.clock_timestamp() THEN
      RETURN 'conflict';
    END IF;
    UPDATE public.woocommerce_connections
    SET status = 'revoked',
        oauth_state = NULL,
        consumer_key_encrypted = NULL,
        consumer_secret_encrypted = NULL,
        disconnected_at = p_disconnected_at,
        last_order_synced_at = NULL,
        order_sync_priority_at = '1970-01-01 00:00:00+00'::timestamptz,
        order_sync_claim_token = NULL,
        order_sync_claimed_until = NULL,
        order_sync_scan_modified_after = NULL,
        order_sync_cohort_modified_at = NULL,
        order_sync_cohort_page = 1,
        order_sync_cohort_pass_found_new = false,
        order_sync_cohort_expected_total = NULL,
        order_sync_cohort_expected_pages = NULL,
        order_sync_cohort_pass_seen_count = 0,
        order_sync_cohort_pass_last_order_id = NULL
    WHERE id = p_connection_id;
    DELETE FROM public.woocommerce_order_sync_seen WHERE connection_id = p_connection_id;
    DELETE FROM public.commerce_order_sync_claim_cancellations
    WHERE provider = 'woocommerce' AND connection_id = p_connection_id;
  ELSE
    RAISE EXCEPTION 'unsupported commerce provider'
      USING ERRCODE = '22023';
  END IF;
  RETURN 'disconnected';
END;
$$;

CREATE OR REPLACE FUNCTION public.revoke_commerce_connection_for_sync(
  p_provider text,
  p_connection_id uuid,
  p_claim_token uuid,
  p_error_message text,
  p_disconnected_at timestamptz
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $$
BEGIN
  IF p_provider = 'shopify' THEN
    PERFORM 1 FROM public.shopify_connections
    WHERE id = p_connection_id
      AND status = 'active'
      AND order_sync_claim_token = p_claim_token
      AND order_sync_claimed_until > pg_catalog.clock_timestamp()
    FOR UPDATE;
    IF NOT FOUND THEN RETURN false; END IF;
    UPDATE public.shopify_connections
    SET status = 'revoked',
        error_message = p_error_message,
        client_id_encrypted = NULL,
        client_secret_encrypted = NULL,
        disconnected_at = p_disconnected_at,
        order_sync_claim_token = NULL,
        order_sync_claimed_until = NULL,
        order_sync_scan_min_updated_at = NULL,
        order_sync_scan_min_inclusive = true,
        order_sync_scan_max_updated_at = NULL,
        order_sync_scan_cohort_updated_at = NULL,
        order_sync_scan_after = NULL,
        order_sync_scan_pass_found_new = false,
        last_order_synced_at = NULL,
        order_sync_priority_at = '1970-01-01 00:00:00+00'::timestamptz
    WHERE id = p_connection_id;
    DELETE FROM public.shopify_order_sync_seen WHERE connection_id = p_connection_id;
    DELETE FROM public.commerce_order_sync_claim_cancellations
    WHERE provider = 'shopify' AND connection_id = p_connection_id;
  ELSIF p_provider = 'woocommerce' THEN
    PERFORM 1 FROM public.woocommerce_connections
    WHERE id = p_connection_id
      AND status = 'active'
      AND order_sync_claim_token = p_claim_token
      AND order_sync_claimed_until > pg_catalog.clock_timestamp()
    FOR UPDATE;
    IF NOT FOUND THEN RETURN false; END IF;
    UPDATE public.woocommerce_connections
    SET status = 'revoked',
        error_message = p_error_message,
        consumer_key_encrypted = NULL,
        consumer_secret_encrypted = NULL,
        disconnected_at = p_disconnected_at,
        order_sync_claim_token = NULL,
        order_sync_claimed_until = NULL,
        order_sync_scan_modified_after = NULL,
        order_sync_cohort_modified_at = NULL,
        order_sync_cohort_page = 1,
        order_sync_cohort_pass_found_new = false,
        order_sync_cohort_expected_total = NULL,
        order_sync_cohort_expected_pages = NULL,
        order_sync_cohort_pass_seen_count = 0,
        order_sync_cohort_pass_last_order_id = NULL,
        last_order_synced_at = NULL,
        order_sync_priority_at = '1970-01-01 00:00:00+00'::timestamptz
    WHERE id = p_connection_id;
    DELETE FROM public.woocommerce_order_sync_seen WHERE connection_id = p_connection_id;
    DELETE FROM public.commerce_order_sync_claim_cancellations
    WHERE provider = 'woocommerce' AND connection_id = p_connection_id;
  ELSE
    RAISE EXCEPTION 'unsupported commerce provider'
      USING ERRCODE = '22023';
  END IF;
  RETURN true;
END;
$$;

REVOKE ALL ON FUNCTION public.enforce_commerce_sync_marker_bound() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.decrement_commerce_sync_marker_count() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.checkpoint_shopify_order_sync(uuid, uuid, timestamptz, boolean, timestamptz, timestamptz, text, boolean, text[]) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.complete_shopify_order_sync_cohort(uuid, uuid, timestamptz) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.complete_shopify_order_sync(uuid, uuid, timestamptz) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.start_woocommerce_order_sync_cohort(uuid, uuid, timestamptz, timestamptz, bigint[], timestamptz) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.record_woocommerce_order_sync_seen(uuid, uuid, timestamptz, bigint[]) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.checkpoint_woocommerce_order_sync(uuid, uuid, timestamptz, timestamptz, integer, boolean, integer, integer, integer, bigint, bigint[]) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.complete_woocommerce_order_sync_cohort(uuid, uuid, timestamptz, timestamptz) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.complete_woocommerce_order_sync(uuid, uuid, timestamptz) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.claim_commerce_order_sync_connection(text, uuid, timestamptz, uuid, timestamptz, timestamptz, boolean) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.release_commerce_order_sync_claim(text, uuid, uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.restore_commerce_order_sync_claim(text, uuid, uuid, timestamptz) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.rotate_ineligible_commerce_order_sync_connection(text, uuid, timestamptz, timestamptz) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.checkpoint_shopify_order_sync(uuid, uuid, timestamptz, boolean, timestamptz, timestamptz, text, boolean, text[]) TO service_role;
GRANT EXECUTE ON FUNCTION public.complete_shopify_order_sync_cohort(uuid, uuid, timestamptz) TO service_role;
GRANT EXECUTE ON FUNCTION public.complete_shopify_order_sync(uuid, uuid, timestamptz) TO service_role;
GRANT EXECUTE ON FUNCTION public.start_woocommerce_order_sync_cohort(uuid, uuid, timestamptz, timestamptz, bigint[], timestamptz) TO service_role;
GRANT EXECUTE ON FUNCTION public.record_woocommerce_order_sync_seen(uuid, uuid, timestamptz, bigint[]) TO service_role;
GRANT EXECUTE ON FUNCTION public.checkpoint_woocommerce_order_sync(uuid, uuid, timestamptz, timestamptz, integer, boolean, integer, integer, integer, bigint, bigint[]) TO service_role;
GRANT EXECUTE ON FUNCTION public.complete_woocommerce_order_sync_cohort(uuid, uuid, timestamptz, timestamptz) TO service_role;
GRANT EXECUTE ON FUNCTION public.complete_woocommerce_order_sync(uuid, uuid, timestamptz) TO service_role;
GRANT EXECUTE ON FUNCTION public.claim_commerce_order_sync_connection(text, uuid, timestamptz, uuid, timestamptz, timestamptz, boolean) TO service_role;
GRANT EXECUTE ON FUNCTION public.release_commerce_order_sync_claim(text, uuid, uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.restore_commerce_order_sync_claim(text, uuid, uuid, timestamptz) TO service_role;
GRANT EXECUTE ON FUNCTION public.rotate_ineligible_commerce_order_sync_connection(text, uuid, timestamptz, timestamptz) TO service_role;
REVOKE ALL ON TABLE public.commerce_order_sync_claim_cancellations FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.commerce_order_sync_claim_cancellations TO service_role;
REVOKE ALL ON FUNCTION public.disconnect_commerce_connection(text, uuid, uuid, timestamptz) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.disconnect_commerce_connection(text, uuid, uuid, timestamptz) TO authenticated, service_role;
REVOKE ALL ON FUNCTION public.revoke_commerce_connection_for_sync(text, uuid, uuid, text, timestamptz) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.revoke_commerce_connection_for_sync(text, uuid, uuid, text, timestamptz) TO service_role;

-- Existing connection UPDATE policies intentionally let members manage safe
-- settings such as transaction_sync_enabled and disconnect state. Protect the
-- new operational progress columns, plus the existing provider cursor, from
-- direct authenticated writes without narrowing those established flows.
CREATE OR REPLACE FUNCTION public.protect_commerce_order_sync_state()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $$
DECLARE
  v_column text;
  v_value jsonb;
BEGIN
  IF auth.role() IN ('anon', 'authenticated')
      AND current_user IN ('anon', 'authenticated') THEN
    FOREACH v_column IN ARRAY TG_ARGV LOOP
      v_value := pg_catalog.to_jsonb(NEW) -> v_column;
      IF TG_OP = 'INSERT' AND (CASE v_column
          WHEN 'order_sync_priority_at' THEN
            v_value IS DISTINCT FROM pg_catalog.to_jsonb(
              '1970-01-01 00:00:00+00'::timestamptz
            )
          WHEN 'order_sync_cohort_page' THEN
            v_value IS DISTINCT FROM pg_catalog.to_jsonb(1)
          WHEN 'order_sync_cohort_pass_found_new' THEN
            v_value IS DISTINCT FROM pg_catalog.to_jsonb(false)
          WHEN 'order_sync_cohort_pass_seen_count' THEN
            v_value IS DISTINCT FROM pg_catalog.to_jsonb(0)
          WHEN 'order_sync_scan_min_inclusive' THEN
            v_value IS DISTINCT FROM pg_catalog.to_jsonb(true)
          WHEN 'order_sync_scan_pass_found_new' THEN
            v_value IS DISTINCT FROM pg_catalog.to_jsonb(false)
          ELSE
            v_value IS DISTINCT FROM 'null'::jsonb
        END) THEN
        RAISE EXCEPTION 'commerce order sync progress is service-managed'
          USING ERRCODE = '42501';
      ELSIF TG_OP = 'UPDATE' AND v_value
          IS DISTINCT FROM pg_catalog.to_jsonb(OLD) -> v_column THEN
        RAISE EXCEPTION 'commerce order sync progress is service-managed'
          USING ERRCODE = '42501';
      END IF;
    END LOOP;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS protect_shopify_order_sync_state
  ON public.shopify_connections;
CREATE TRIGGER protect_shopify_order_sync_state
  BEFORE INSERT OR UPDATE ON public.shopify_connections
  FOR EACH ROW EXECUTE FUNCTION public.protect_commerce_order_sync_state(
    'last_order_synced_at',
    'order_sync_priority_at',
    'order_sync_claim_token',
    'order_sync_claimed_until',
    'order_sync_scan_min_updated_at',
    'order_sync_scan_min_inclusive',
    'order_sync_scan_max_updated_at',
    'order_sync_scan_cohort_updated_at',
    'order_sync_scan_after',
    'order_sync_scan_pass_found_new'
  );

DROP TRIGGER IF EXISTS protect_woocommerce_order_sync_state
  ON public.woocommerce_connections;
CREATE TRIGGER protect_woocommerce_order_sync_state
  BEFORE INSERT OR UPDATE ON public.woocommerce_connections
  FOR EACH ROW EXECUTE FUNCTION public.protect_commerce_order_sync_state(
    'last_order_synced_at',
    'order_sync_priority_at',
    'order_sync_claim_token',
    'order_sync_claimed_until',
    'order_sync_scan_modified_after',
    'order_sync_cohort_modified_at',
    'order_sync_cohort_page',
    'order_sync_cohort_pass_found_new',
    'order_sync_cohort_expected_total',
    'order_sync_cohort_expected_pages',
    'order_sync_cohort_pass_seen_count',
    'order_sync_cohort_pass_last_order_id'
  );

NOTIFY pgrst, 'reload schema';
