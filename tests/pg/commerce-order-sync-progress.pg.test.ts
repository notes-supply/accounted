import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { seedCompany } from './fixtures'
import { getPool, withUserContext } from './setup'

describe('commerce order sync durable progress', () => {
  it('defaults newly connected provider work to the oldest queue priority', async () => {
    const { userId, companyId } = await seedCompany()
    const shopDomain = `queue-${randomUUID()}.myshopify.com`
    const storeUrl = `https://queue-${randomUUID()}.example.se`
    const { rows: shopRows } = await getPool().query(
      `INSERT INTO public.shopify_connections
         (company_id, user_id, shop_domain, status, last_order_synced_at)
       VALUES ($1, $2, $3, 'active', NULL)
       RETURNING order_sync_priority_at`,
      [companyId, userId, shopDomain],
    )
    expect(new Date(shopRows[0].order_sync_priority_at).toISOString()).toBe(
      '1970-01-01T00:00:00.000Z',
    )

    await getPool().query(
      `UPDATE public.shopify_connections SET status = 'revoked' WHERE shop_domain = $1`,
      [shopDomain],
    )
    const { rows: wooRows } = await getPool().query(
      `INSERT INTO public.woocommerce_connections
         (company_id, user_id, store_url, status, last_order_synced_at)
       VALUES ($1, $2, $3, 'active', '2026-08-01T12:00:00Z')
       RETURNING order_sync_priority_at`,
      [companyId, userId, storeUrl],
    )
    expect(new Date(wooRows[0].order_sync_priority_at).toISOString()).toBe(
      '1970-01-01T00:00:00.000Z',
    )
  })

  it('keeps cohort completion markers hidden from authenticated members', async () => {
    const { userId, companyId } = await seedCompany()
    const { rows } = await getPool().query(
      `INSERT INTO public.woocommerce_connections
         (company_id, user_id, store_url, status)
       VALUES ($1, $2, $3, 'active') RETURNING id`,
      [companyId, userId, `https://seen-${randomUUID()}.example.se`],
    )
    await getPool().query(
      `INSERT INTO public.woocommerce_order_sync_seen
         (connection_id, modified_at, order_id)
       VALUES ($1, '2026-08-01T12:00:00Z', 42)`,
      [rows[0].id],
    )

    await withUserContext(userId, async client => {
      const result = await client.query(
        `SELECT order_id FROM public.woocommerce_order_sync_seen
         WHERE connection_id = $1`,
        [rows[0].id],
      )
      expect(result.rows).toHaveLength(0)
    })
  })

  it('rejects invalid cohort pages and cascades operational markers', async () => {
    const { userId, companyId } = await seedCompany()
    const { rows } = await getPool().query(
      `INSERT INTO public.woocommerce_connections
         (company_id, user_id, store_url, status)
       VALUES ($1, $2, $3, 'active') RETURNING id`,
      [companyId, userId, `https://cascade-${randomUUID()}.example.se`],
    )
    await expect(
      getPool().query(
        `UPDATE public.woocommerce_connections
         SET order_sync_cohort_page = 0 WHERE id = $1`,
        [rows[0].id],
      ),
    ).rejects.toMatchObject({ code: '23514' })

    await getPool().query(
      `INSERT INTO public.woocommerce_order_sync_seen
         (connection_id, modified_at, order_id)
       VALUES ($1, '2026-08-01T12:00:00Z', 42)`,
      [rows[0].id],
    )
    await getPool().query(
      `DELETE FROM public.woocommerce_connections WHERE id = $1`,
      [rows[0].id],
    )
    const remaining = await getPool().query(
      `SELECT 1 FROM public.woocommerce_order_sync_seen WHERE connection_id = $1`,
      [rows[0].id],
    )
    expect(remaining.rows).toHaveLength(0)

    const { rows: shopRows } = await getPool().query(
      `INSERT INTO public.shopify_connections
         (company_id, user_id, shop_domain, status)
       VALUES ($1, $2, $3, 'active') RETURNING id`,
      [companyId, userId, `cascade-${randomUUID()}.myshopify.com`],
    )
    await getPool().query(
      `INSERT INTO public.shopify_order_sync_seen
         (connection_id, updated_at, order_id)
       VALUES ($1, '2026-08-01T12:00:00Z', '42')`,
      [shopRows[0].id],
    )
    await getPool().query(
      `DELETE FROM public.shopify_connections WHERE id = $1`,
      [shopRows[0].id],
    )
    const shopRemaining = await getPool().query(
      `SELECT 1 FROM public.shopify_order_sync_seen WHERE connection_id = $1`,
      [shopRows[0].id],
    )
    expect(shopRemaining.rows).toHaveLength(0)
  })

  it.each([
    {
      table: 'shopify_connections',
      identityColumn: 'shop_domain',
      identity: () => `guard-${randomUUID()}.myshopify.com`,
    },
    {
      table: 'woocommerce_connections',
      identityColumn: 'store_url',
      identity: () => `https://guard-${randomUUID()}.example.se`,
    },
  ])('lets members change safe settings but blocks $table progress', async spec => {
    const { userId, companyId } = await seedCompany()
    const { rows } = await getPool().query(
      `INSERT INTO public.${spec.table}
         (company_id, user_id, ${spec.identityColumn}, status)
       VALUES ($1, $2, $3, 'active') RETURNING id`,
      [companyId, userId, spec.identity()],
    )

    await withUserContext(userId, async client => {
      await client.query(
        `SELECT set_config('request.jwt.claim.role', 'authenticated', true)`,
      )
      const safe = await client.query(
        `UPDATE public.${spec.table}
         SET transaction_sync_enabled = true WHERE id = $1`,
        [rows[0].id],
      )
      expect(safe.rowCount).toBe(1)
      await expect(
        client.query(
          `UPDATE public.${spec.table}
           SET last_order_synced_at = '2030-01-01T00:00:00Z' WHERE id = $1`,
          [rows[0].id],
        ),
      ).rejects.toMatchObject({ code: '42501' })
    })
  })

  it.each([
    {
      table: 'shopify_connections',
      identityColumn: 'shop_domain',
      identity: () => `insert-guard-${randomUUID()}.myshopify.com`,
      forgedColumns:
        'last_order_synced_at, order_sync_priority_at, order_sync_claim_token, order_sync_claimed_until',
      forgedValues:
        "'2030-01-01T00:00:00Z', '2030-01-01T00:00:00Z', gen_random_uuid(), '2030-01-01T00:10:00Z'",
      safeColumns:
        'last_order_synced_at, order_sync_priority_at, order_sync_claim_token, order_sync_claimed_until',
      safeValues:
        "NULL, '1970-01-01T00:00:00Z', NULL, NULL",
    },
    {
      table: 'woocommerce_connections',
      identityColumn: 'store_url',
      identity: () => `https://insert-guard-${randomUUID()}.example.se`,
      forgedColumns:
        'last_order_synced_at, order_sync_priority_at, order_sync_claim_token, order_sync_claimed_until, order_sync_cohort_modified_at, order_sync_cohort_page, order_sync_cohort_pass_found_new',
      forgedValues:
        "'2030-01-01T00:00:00Z', '2030-01-01T00:00:00Z', gen_random_uuid(), '2030-01-01T00:10:00Z', '2030-01-01T00:00:00Z', 2, true",
      safeColumns:
        'last_order_synced_at, order_sync_priority_at, order_sync_claim_token, order_sync_claimed_until, order_sync_cohort_modified_at, order_sync_cohort_page, order_sync_cohort_pass_found_new',
      safeValues:
        "NULL, '1970-01-01T00:00:00Z', NULL, NULL, NULL, 1, false",
    },
  ])('allows safe member inserts but rejects forged $table progress', async spec => {
    const { userId, companyId } = await seedCompany()

    await withUserContext(userId, async client => {
      await client.query(
        `SELECT set_config('request.jwt.claim.role', 'authenticated', true)`,
      )
      const omittedDefaults = await client.query(
        `INSERT INTO public.${spec.table}
           (company_id, user_id, ${spec.identityColumn}, status)
         VALUES ($1, $2, $3, 'pending')
         RETURNING order_sync_priority_at`,
        [companyId, userId, spec.identity()],
      )
      expect(omittedDefaults.rowCount).toBe(1)
      expect(new Date(omittedDefaults.rows[0].order_sync_priority_at).toISOString()).toBe(
        '1970-01-01T00:00:00.000Z',
      )

      const explicitDefaults = await client.query(
        `INSERT INTO public.${spec.table}
           (company_id, user_id, ${spec.identityColumn}, status,
            ${spec.safeColumns})
         VALUES ($1, $2, $3, 'pending', ${spec.safeValues})
        RETURNING order_sync_priority_at`,
        [companyId, userId, spec.identity()],
      )
      expect(explicitDefaults.rowCount).toBe(1)
      expect(new Date(explicitDefaults.rows[0].order_sync_priority_at).toISOString()).toBe(
        '1970-01-01T00:00:00.000Z',
      )

      await expect(
        client.query(
          `INSERT INTO public.${spec.table}
             (company_id, user_id, ${spec.identityColumn}, status,
              ${spec.forgedColumns})
           VALUES ($1, $2, $3, 'error', ${spec.forgedValues})`,
          [companyId, userId, spec.identity()],
        ),
      ).rejects.toMatchObject({ code: '42501' })
    })
  })

  it('allows exactly one concurrent claim winner and rejects stale token cleanup', async () => {
    const { userId, companyId } = await seedCompany()
    const { rows } = await getPool().query(
      `INSERT INTO public.shopify_connections
         (company_id, user_id, shop_domain, status, transaction_sync_enabled)
       VALUES ($1, $2, $3, 'active', true)
       RETURNING id, order_sync_priority_at`,
      [companyId, userId, `cas-${randomUUID()}.myshopify.com`],
    )
    const connectionId = rows[0].id as string
    const priority = rows[0].order_sync_priority_at as string
    const tokenA = randomUUID()
    const tokenB = randomUUID()
    const claim = (token: string) => getPool().query(
      `SELECT public.claim_commerce_order_sync_connection(
         'shopify', $1, $2, $3, clock_timestamp(), clock_timestamp() + interval '10 minutes', true
       ) AS claimed`,
      [connectionId, priority, token],
    )

    const [claimA, claimB] = await Promise.all([claim(tokenA), claim(tokenB)])
    const winners = [claimA.rows[0].claimed, claimB.rows[0].claimed]
    expect(winners.filter(Boolean)).toHaveLength(1)
    const winningToken = claimA.rows[0].claimed ? tokenA : tokenB
    const staleToken = claimA.rows[0].claimed ? tokenB : tokenA

    const staleRelease = await getPool().query(
      `SELECT public.release_commerce_order_sync_claim('shopify', $1, $2) AS released`,
      [connectionId, staleToken],
    )
    expect(staleRelease.rows[0].released).toBe(false)
    const staleRestore = await getPool().query(
      `SELECT public.restore_commerce_order_sync_claim('shopify', $1, $2, $3) AS restored`,
      [connectionId, staleToken, priority],
    )
    expect(staleRestore.rows[0].restored).toBe(false)
    const winnerRelease = await getPool().query(
      `SELECT public.release_commerce_order_sync_claim('shopify', $1, $2) AS released`,
      [connectionId, winningToken],
    )
    expect(winnerRelease.rows[0].released).toBe(true)
  })

  it('requires active exact-token leases for Shopify and WooCommerce progress', async () => {
    const { userId, companyId } = await seedCompany()
    const claimToken = randomUUID()
    const { rows: shopRows } = await getPool().query(
      `INSERT INTO public.shopify_connections
         (company_id, user_id, shop_domain, status, order_sync_claim_token, order_sync_claimed_until)
       VALUES ($1, $2, $3, 'active', $4, clock_timestamp() + interval '10 minutes')
       RETURNING id`,
      [companyId, userId, `guard-${randomUUID()}.myshopify.com`, claimToken],
    )
    const checkpoint = await getPool().query(
      `SELECT public.checkpoint_shopify_order_sync(
         $1, $2, '2026-08-01T00:00:00Z', true, '2026-08-02T00:00:00Z',
         '2026-08-01T12:00:00Z', NULL, false, ARRAY['42']::text[]
       ) AS changed`,
      [shopRows[0].id, randomUUID()],
    )
    expect(checkpoint.rows[0].changed).toBe(false)

    const wooToken = randomUUID()
    const { rows: wooRows } = await getPool().query(
      `INSERT INTO public.woocommerce_connections
         (company_id, user_id, store_url, status, order_sync_claim_token, order_sync_claimed_until)
       VALUES ($1, $2, $3, 'active', $4, clock_timestamp() + interval '10 minutes')
       RETURNING id`,
      [companyId, userId, `https://guard-${randomUUID()}.example.se`, wooToken],
    )
    const wrongToken = await getPool().query(
      `SELECT public.record_woocommerce_order_sync_seen(
         $1, $2, '2026-08-01T12:00:00Z', ARRAY[42]::bigint[]
       ) AS changed`,
      [wooRows[0].id, randomUUID()],
    )
    expect(wrongToken.rows[0].changed).toBe(false)
    await getPool().query(
      `UPDATE public.woocommerce_connections SET status = 'revoked' WHERE id = $1`,
      [wooRows[0].id],
    )
    const inactive = await getPool().query(
      `SELECT public.record_woocommerce_order_sync_seen(
         $1, $2, '2026-08-01T12:00:00Z', ARRAY[42]::bigint[]
       ) AS changed`,
      [wooRows[0].id, wooToken],
    )
    expect(inactive.rows[0].changed).toBe(false)
  })

  it('serializes disconnect against an active lease and cleans expired operational state', async () => {
    const { userId, companyId } = await seedCompany()
    const claimToken = randomUUID()
    const { rows } = await getPool().query(
      `INSERT INTO public.woocommerce_connections
         (company_id, user_id, store_url, status, consumer_key_encrypted,
          consumer_secret_encrypted, order_sync_claim_token, order_sync_claimed_until,
          order_sync_cohort_modified_at, order_sync_cohort_page)
       VALUES ($1, $2, $3, 'active', 'key', 'secret', $4,
         clock_timestamp() + interval '10 minutes', '2026-08-01T12:00:00Z', 2)
       RETURNING id`,
      [companyId, userId, `https://disconnect-${randomUUID()}.example.se`, claimToken],
    )
    const connectionId = rows[0].id as string
    await getPool().query(
      `INSERT INTO public.woocommerce_order_sync_seen(connection_id, modified_at, order_id)
       VALUES ($1, '2026-08-01T12:00:00Z', 42)`,
      [connectionId],
    )

    await withUserContext(userId, async client => {
      const active = await client.query(
        `SELECT public.disconnect_commerce_connection(
           'woocommerce', $1, $2, clock_timestamp()
         ) AS result`,
        [connectionId, companyId],
      )
      expect(active.rows[0].result).toBe('conflict')
    })
    await getPool().query(
      `UPDATE public.woocommerce_connections
       SET order_sync_claimed_until = clock_timestamp() - interval '1 second'
       WHERE id = $1`,
      [connectionId],
    )
    await withUserContext(userId, async client => {
      const expired = await client.query(
        `SELECT public.disconnect_commerce_connection(
           'woocommerce', $1, $2, clock_timestamp()
         ) AS result`,
        [connectionId, companyId],
      )
      expect(expired.rows[0].result).toBe('disconnected')
    }, { commit: true })
    const cleaned = await getPool().query(
      `SELECT status, consumer_key_encrypted, consumer_secret_encrypted,
              order_sync_claim_token, order_sync_claimed_until,
              order_sync_cohort_modified_at, order_sync_cohort_page
       FROM public.woocommerce_connections WHERE id = $1`,
      [connectionId],
    )
    expect(cleaned.rows[0]).toMatchObject({
      status: 'revoked',
      consumer_key_encrypted: null,
      consumer_secret_encrypted: null,
      order_sync_claim_token: null,
      order_sync_claimed_until: null,
      order_sync_cohort_modified_at: null,
      order_sync_cohort_page: 1,
    })
    const markers = await getPool().query(
      `SELECT 1 FROM public.woocommerce_order_sync_seen WHERE connection_id = $1`,
      [connectionId],
    )
    expect(markers.rows).toHaveLength(0)
  })

  it('makes disconnect win before claim and rejects stale post-revoke progress', async () => {
    const { userId, companyId } = await seedCompany()
    const { rows } = await getPool().query(
      `INSERT INTO public.shopify_connections
         (company_id, user_id, shop_domain, status, client_id_encrypted,
          client_secret_encrypted, transaction_sync_enabled)
       VALUES ($1, $2, $3, 'active', 'client', 'secret', true)
       RETURNING id, order_sync_priority_at`,
      [companyId, userId, `disconnect-wins-${randomUUID()}.myshopify.com`],
    )
    const connectionId = rows[0].id as string
    await withUserContext(userId, async client => {
      const disconnected = await client.query(
        `SELECT public.disconnect_commerce_connection(
           'shopify', $1, $2, clock_timestamp()
         ) AS result`,
        [connectionId, companyId],
      )
      expect(disconnected.rows[0].result).toBe('disconnected')
    }, { commit: true })
    const staleToken = randomUUID()
    const claim = await getPool().query(
      `SELECT public.claim_commerce_order_sync_connection(
         'shopify', $1, $2, $3, clock_timestamp(),
         clock_timestamp() + interval '10 minutes', true
       ) AS claimed`,
      [connectionId, rows[0].order_sync_priority_at, staleToken],
    )
    expect(claim.rows[0].claimed).toBe(false)
    const checkpoint = await getPool().query(
      `SELECT public.checkpoint_shopify_order_sync(
         $1, $2, '2026-08-01T00:00:00Z', true, '2026-08-02T00:00:00Z',
         NULL, NULL, false, ARRAY[]::text[]
       ) AS changed`,
      [connectionId, staleToken],
    )
    expect(checkpoint.rows[0].changed).toBe(false)
  })

  it.each([
    {
      provider: 'Shopify',
      connectionsTable: 'shopify_connections',
      identityColumn: 'shop_domain',
      identity: () => `marker-count-${randomUUID()}.myshopify.com`,
      seenTable: 'shopify_order_sync_seen',
      timestampColumn: 'updated_at',
      firstOrderId: "'42'",
      secondOrderId: "'43'",
      countTable: 'shopify_order_sync_marker_counts',
    },
    {
      provider: 'WooCommerce',
      connectionsTable: 'woocommerce_connections',
      identityColumn: 'store_url',
      identity: () => `https://marker-count-${randomUUID()}.example.se`,
      seenTable: 'woocommerce_order_sync_seen',
      timestampColumn: 'modified_at',
      firstOrderId: '42',
      secondOrderId: '43',
      countTable: 'woocommerce_order_sync_marker_counts',
    },
  ])('counts only inserted $provider markers and decrements on delete', async spec => {
    const { userId, companyId } = await seedCompany()
    const { rows } = await getPool().query(
      `INSERT INTO public.${spec.connectionsTable}
         (company_id, user_id, ${spec.identityColumn}, status)
       VALUES ($1, $2, $3, 'active') RETURNING id`,
      [companyId, userId, spec.identity()],
    )
    const connectionId = rows[0].id as string

    await getPool().query(
      `INSERT INTO public.${spec.seenTable}
         (connection_id, ${spec.timestampColumn}, order_id)
       VALUES ($1, '2026-08-01T12:00:00Z', ${spec.firstOrderId})`,
      [connectionId],
    )
    await getPool().query(
      `INSERT INTO public.${spec.seenTable}
         (connection_id, ${spec.timestampColumn}, order_id)
       VALUES
         ($1, '2026-08-01T12:00:00Z', ${spec.firstOrderId}),
         ($1, '2026-08-01T12:00:00Z', ${spec.secondOrderId})
       ON CONFLICT DO NOTHING`,
      [connectionId],
    )
    const afterInsert = await getPool().query(
      `SELECT marker_count FROM public.${spec.countTable}
       WHERE connection_id = $1`,
      [connectionId],
    )
    expect(afterInsert.rows[0].marker_count).toBe(2)

    await getPool().query(
      `DELETE FROM public.${spec.seenTable}
       WHERE connection_id = $1 AND order_id = ${spec.secondOrderId}`,
      [connectionId],
    )
    const afterDelete = await getPool().query(
      `SELECT marker_count FROM public.${spec.countTable}
       WHERE connection_id = $1`,
      [connectionId],
    )
    expect(afterDelete.rows[0].marker_count).toBe(1)
  })

  it('serializes concurrent marker inserts at the per-connection cap', async () => {
    const { userId, companyId } = await seedCompany()
    const { rows } = await getPool().query(
      `INSERT INTO public.woocommerce_connections
         (company_id, user_id, store_url, status)
       VALUES ($1, $2, $3, 'active') RETURNING id`,
      [companyId, userId, `https://concurrent-bound-${randomUUID()}.example.se`],
    )
    const connectionId = rows[0].id as string
    await getPool().query(
      `INSERT INTO public.woocommerce_order_sync_seen
         (connection_id, modified_at, order_id)
       VALUES ($1, '2026-08-01T12:00:00Z', 42)`,
      [connectionId],
    )
    await getPool().query(
      `UPDATE public.woocommerce_order_sync_marker_counts
       SET marker_count = 99999 WHERE connection_id = $1`,
      [connectionId],
    )

    const insertMarker = (orderId: number) => getPool().query(
      `INSERT INTO public.woocommerce_order_sync_seen
         (connection_id, modified_at, order_id)
       VALUES ($1, '2026-08-01T12:00:00Z', $2)`,
      [connectionId, orderId],
    )
    const results = await Promise.allSettled([insertMarker(43), insertMarker(44)])
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1)
    const rejected = results.find(result => result.status === 'rejected')
    expect(rejected).toMatchObject({ reason: { code: '54000' } })

    const remaining = await getPool().query(
      `SELECT pg_catalog.count(*)::integer AS marker_rows
       FROM public.woocommerce_order_sync_seen WHERE connection_id = $1`,
      [connectionId],
    )
    expect(remaining.rows[0].marker_rows).toBe(2)
  })

  it('fails loudly and atomically when the per-connection marker cap is exceeded', async () => {
    const { userId, companyId } = await seedCompany()
    const { rows } = await getPool().query(
      `INSERT INTO public.woocommerce_connections
         (company_id, user_id, store_url, status)
       VALUES ($1, $2, $3, 'active') RETURNING id`,
      [companyId, userId, `https://bound-${randomUUID()}.example.se`],
    )
    await expect(getPool().query(
      `INSERT INTO public.woocommerce_order_sync_seen(connection_id, modified_at, order_id)
       SELECT $1, '2026-08-01T12:00:00Z', value
       FROM generate_series(1, 100001) AS value`,
      [rows[0].id],
    )).rejects.toMatchObject({ code: '54000' })
    const remaining = await getPool().query(
      `SELECT count(*)::integer AS count
       FROM public.woocommerce_order_sync_seen WHERE connection_id = $1`,
      [rows[0].id],
    )
    expect(remaining.rows[0].count).toBe(0)
  })
})
