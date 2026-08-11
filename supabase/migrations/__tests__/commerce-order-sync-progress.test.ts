import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const migration = readFileSync(
  resolve(
    process.cwd(),
    'supabase/migrations/20260810210000_commerce_order_sync_progress.sql',
  ),
  'utf8',
)

describe('commerce order sync progress migration', () => {
  it('adds independent queue and tokenized lease state to both providers', () => {
    for (const table of ['shopify_connections', 'woocommerce_connections']) {
      expect(migration).toContain(`ALTER TABLE public.${table}`)
    }
    expect(migration.match(/ADD COLUMN IF NOT EXISTS order_sync_priority_at/g)).toHaveLength(2)
    expect(migration.match(/ADD COLUMN IF NOT EXISTS order_sync_claim_token uuid/g)).toHaveLength(2)
    expect(migration.match(/ADD COLUMN IF NOT EXISTS order_sync_claimed_until/g)).toHaveLength(2)
    expect(migration.match(
      /WHEN last_order_synced_at IS NULL\s+THEN '1970-01-01 00:00:00\+00'::timestamptz/g,
    )).toHaveLength(2)
    expect(migration.match(
      /ELSE LEAST\(last_order_synced_at, pg_catalog\.clock_timestamp\(\)\)/g,
    )).toHaveLength(2)
  })

  it('keeps WooCommerce cohort progress out of the timestamp cursor alone', () => {
    expect(migration).toContain('order_sync_cohort_modified_at timestamptz')
    expect(migration).toContain('order_sync_cohort_page integer NOT NULL DEFAULT 1')
    expect(migration).toContain('order_sync_cohort_pass_found_new boolean NOT NULL DEFAULT false')
    expect(migration).toContain('CREATE TABLE IF NOT EXISTS public.woocommerce_order_sync_seen')
    expect(migration).toContain('PRIMARY KEY (connection_id, modified_at, order_id)')
    expect(migration).toContain('ON DELETE CASCADE')
  })

  it('keeps completion markers service-only and reloads PostgREST', () => {
    expect(migration).toContain(
      'ALTER TABLE public.woocommerce_order_sync_seen ENABLE ROW LEVEL SECURITY;',
    )
    expect(migration).not.toMatch(/CREATE POLICY[\s\S]+woocommerce_order_sync_seen/)
    expect(migration).toContain(
      'ALTER TABLE public.woocommerce_order_sync_marker_counts ENABLE ROW LEVEL SECURITY;',
    )
    expect(migration).toContain(
      'ALTER TABLE public.shopify_order_sync_marker_counts ENABLE ROW LEVEL SECURITY;',
    )
    expect(migration).toContain("NOTIFY pgrst, 'reload schema';")
  })

  it('bounds markers loudly and cleans them on transition, revocation, and cascade', () => {
    expect(migration).toContain('CREATE OR REPLACE FUNCTION public.enforce_commerce_sync_marker_bound()')
    expect(migration).toContain('pg_catalog.pg_advisory_xact_lock')
    expect(migration).toContain("TG_TABLE_SCHEMA <> 'public'")
    expect(migration).toContain("TG_TABLE_NAME NOT IN (")
    expect(migration).toContain('FROM inserted_rows')
    expect(migration).toContain('ORDER BY connection_id')
    expect(migration).toContain('marker_counts.marker_count <= 100000 - EXCLUDED.marker_count')
    expect(migration).toContain("USING ERRCODE = '54000'")
    expect(migration.match(
      /AFTER INSERT ON public\.(?:shopify|woocommerce)_order_sync_seen\s+REFERENCING NEW TABLE AS inserted_rows\s+FOR EACH STATEMENT/g,
    )).toHaveLength(2)
    expect(migration).not.toMatch(
      /(?:BEFORE|AFTER) INSERT ON public\.(?:shopify|woocommerce)_order_sync_seen\s+FOR EACH ROW[\s\S]*?enforce_commerce_sync_marker_bound/,
    )
    expect(migration.match(
      /AFTER DELETE ON public\.(?:shopify|woocommerce)_order_sync_seen\s+REFERENCING OLD TABLE AS deleted_rows\s+FOR EACH STATEMENT/g,
    )).toHaveLength(2)
    expect(migration.match(/ON DELETE CASCADE/g)).toHaveLength(4)
    expect(migration.match(/DELETE FROM public\.shopify_order_sync_seen/g).length).toBeGreaterThanOrEqual(4)
    expect(migration.match(/DELETE FROM public\.woocommerce_order_sync_seen/g).length).toBeGreaterThanOrEqual(4)
  })

  it('uses atomic exact-token lifecycle and active progress guards', () => {
    expect(migration).toContain('CREATE OR REPLACE FUNCTION public.claim_commerce_order_sync_connection(')
    expect(migration).toContain('AND order_sync_priority_at = p_expected_priority_at')
    expect(migration).toContain('OR order_sync_claimed_until < p_claimed_at')
    expect(migration).toContain('RETURN v_changed = 1;')
    expect(migration).toContain('CREATE OR REPLACE FUNCTION public.disconnect_commerce_connection(')
    expect(migration).toContain('FOR UPDATE;')
    expect(migration).toContain("RETURN 'conflict';")
    expect(migration.match(/AND status = 'active'\s+AND order_sync_claim_token = p_claim_token\s+AND order_sync_claimed_until >/g).length).toBeGreaterThanOrEqual(7)
    expect(migration).toContain('RETURN FOUND;')
  })

  it('guards provider progress from direct authenticated connection inserts and updates', () => {
    expect(migration).toContain('CREATE OR REPLACE FUNCTION public.protect_commerce_order_sync_state()')
    expect(migration).toContain("IF auth.role() IN ('anon', 'authenticated')")
    expect(migration).toContain("AND current_user IN ('anon', 'authenticated') THEN")
    expect(migration).toContain("USING ERRCODE = '42501'")
    expect(migration).toContain('CREATE TRIGGER protect_shopify_order_sync_state')
    expect(migration).toContain('CREATE TRIGGER protect_woocommerce_order_sync_state')
    expect(migration.match(/BEFORE INSERT OR UPDATE ON public\./g)).toHaveLength(2)
    expect(migration).toContain("WHEN 'order_sync_priority_at' THEN")
    expect(migration).toContain("WHEN 'order_sync_cohort_page' THEN")
    expect(migration).toContain("WHEN 'order_sync_cohort_pass_found_new' THEN")
    expect(migration).toContain("v_value IS DISTINCT FROM 'null'::jsonb")
    expect(migration.match(/'last_order_synced_at'/g)).toHaveLength(2)
  })
})
