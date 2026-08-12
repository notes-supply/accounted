import { createClient } from '@supabase/supabase-js'
import { NextResponse } from 'next/server'
import { withCronContext } from '@/lib/api/with-cron-context'
import { errorResponse, errorResponseFromCode } from '@/lib/errors/get-structured-error'
import { CAPABILITY } from '@/lib/entitlements/keys'
import { loadExtensions } from '@/lib/extensions/loader'
import { extensionRegistry } from '@/lib/extensions/registry'
import {
  claimCommerceOrderSyncConnections,
  releaseCommerceOrderSyncClaim,
  restoreCommerceOrderSyncClaim,
} from '@/lib/commerce/order-sync-scheduler'
import { isShopifyConfigured } from '@/extensions/general/shopify/lib/credentials'
import { syncShopifyOrders } from '@/extensions/general/shopify/lib/order-sync'
import type { ShopifyConnection } from '@/extensions/general/shopify/types'
import {
  CommerceSyncPersistenceError,
  commerceSyncFailureSummary,
  type CommerceSyncTotals,
} from '@/lib/commerce/order-sync-errors'

export const maxDuration = 300

// One provider operation can consume about 94 seconds: three 30 second
// attempts plus backoff. No operation starts after this deadline, leaving at
// least 26 seconds inside maxDuration for the bounded call and durable state.
const WORK_START_BUDGET_MS = 180_000

const SELECTION_TIMEOUT_MESSAGE_SV =
  'Tidsgränsen nåddes innan urvalet för synkronisering blev klart.'
const SELECTION_TIMEOUT_MESSAGE_EN =
  'The time budget was reached before sync selection completed.'

interface ShopifyCronResult extends CommerceSyncTotals {
  connectionId: string
  status: 'synced' | 'revoked' | 'error'
}

function toCronResult(
  connectionId: string,
  summary: CommerceSyncTotals | undefined,
  status: ShopifyCronResult['status'],
): ShopifyCronResult {
  return {
    connectionId,
    fetched: summary?.fetched ?? 0,
    refundsFetched: summary?.refundsFetched ?? 0,
    imported: summary?.imported ?? 0,
    duplicates: summary?.duplicates ?? 0,
    skippedLocked: summary?.skippedLocked ?? 0,
    errors: summary?.errors ?? 0,
    ...(summary?.deadlineReached ? { deadlineReached: true } : {}),
    ...(summary?.revoked ? { revoked: true } : {}),
    status,
  }
}

/**
 * GET /api/extensions/shopify/orders/cron
 * Nightly order sync for connections that opted in (transaction_sync_enabled):
 * imports each connected store's paid orders and refunds into the
 * transactions inbox as a bank-style feed on the 1584 cash account.
 *
 * Read-only against the stores, and it never posts to the journal: rows land
 * unbooked; booking stays a human decision. Idempotent via the
 * (company_id, external_id) unique index, so overlapping windows and re-runs
 * are no-ops. Emits no events, so no ensureInitialized() is needed.
 */
export const GET = withCronContext('cron.shopify_order_sync', async (_request, ctx) => {
  const routeStartMs = Date.now()
  const cleanupDeadlineMs = routeStartMs + 285_000
  // Physical routes under app/api/extensions/<id>/ compile into EVERY build,
  // including the core-with-zero-extensions one: the registry (generated from
  // extensions.config.json) is what actually switches an extension on. A
  // scheduled-but-disabled cron must fail visibly (503) instead of quietly
  // doing the work anyway.
  loadExtensions()
  if (!extensionRegistry.get('shopify')) {
    ctx.log.warn('shopify extension is not enabled; cron refused')
    return NextResponse.json(
      { error: 'Shopify extension is not enabled', code: 'EXTENSION_DISABLED' },
      { status: 503 },
    )
  }

  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL
  const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY

  if (!supabaseUrl || !supabaseServiceKey) {
    return errorResponseFromCode('INTERNAL_ERROR', ctx.log, {
      requestId: ctx.requestId,
      details: { reason: 'Missing Supabase configuration' },
    })
  }
  if (!isShopifyConfigured()) {
    return NextResponse.json({ message: 'Shopify not configured', processed: 0 })
  }

  const supabase = createClient(supabaseUrl, supabaseServiceKey)

  const deadlineMs = routeStartMs + WORK_START_BUDGET_MS
  const selectionTimeoutResponse = (completedResults: ShopifyCronResult[] = []) => {
    ctx.log.error(
      'shopify sync selection exceeded time budget',
      new Error(SELECTION_TIMEOUT_MESSAGE_EN),
    )
    return NextResponse.json(
      {
        error: {
          code: 'CRON_SELECTION_TIMEOUT',
          message: SELECTION_TIMEOUT_MESSAGE_SV,
          message_en: SELECTION_TIMEOUT_MESSAGE_EN,
          requestId: ctx.requestId,
        },
        processed: completedResults.length,
        imported: completedResults.reduce((total, result) => total + result.imported, 0),
        duplicates: completedResults.reduce((total, result) => total + result.duplicates, 0),
        errors: completedResults.reduce((total, result) => total + result.errors, 0),
        results: completedResults,
      },
      { status: 504 },
    )
  }

  let selection
  try {
    selection = await claimCommerceOrderSyncConnections<ShopifyConnection>({
      supabase,
      table: 'shopify_connections',
      capability: CAPABILITY.shopify_sync,
      selectionDeadlineMs: deadlineMs,
      cleanupDeadlineMs,
      log: ctx.log,
    })
  } catch (error) {
    ctx.log.error('failed to select and claim shopify connections', error as Error)
    return errorResponse(error, ctx.log, { requestId: ctx.requestId })
  }
  if (selection.timedOut) return selectionTimeoutResponse()

  if (!selection.foundAnyConnection) {
    return NextResponse.json({
      message: 'No connections with transaction sync enabled',
      processed: 0,
    })
  }

  // Shared with syncShopifyOrders: it stops between pages and persists its
  // cursor, so a truncated connection resumes next night.
  const results: ShopifyCronResult[] = []
  let queuePersistenceError: Error | null = null
  let workTimedOut = false

  for (let index = 0; index < selection.claims.length; index++) {
    const claim = selection.claims[index]
    const connection = claim.connection
    if (Date.now() >= deadlineMs) {
      workTimedOut = true
      ctx.log.info('time budget reached', { processedSoFar: results.length })
      for (const unstarted of selection.claims.slice(index)) {
        try {
          await restoreCommerceOrderSyncClaim(
            supabase,
            'shopify_connections',
            unstarted,
            cleanupDeadlineMs,
          )
        } catch (error) {
          queuePersistenceError = error as Error
          ctx.log.error('failed to restore unstarted shopify sync claim', error as Error, {
            connectionId: unstarted.connection.id,
          })
        }
      }
      break
    }

    let summary = undefined as ReturnType<typeof commerceSyncFailureSummary>
    try {
      const syncSummary = await syncShopifyOrders(supabase, connection, ctx.log, deadlineMs)
      summary = syncSummary
      const timedOutAfterSync = Date.now() >= deadlineMs || syncSummary.deadlineReached === true
      if (timedOutAfterSync) workTimedOut = true
      if (!syncSummary.revoked) {
        try {
          await releaseCommerceOrderSyncClaim(
            supabase,
            'shopify_connections',
            connection.id,
            claim.claimToken,
            cleanupDeadlineMs,
          )
        } catch (releaseError) {
          queuePersistenceError = releaseError as Error
          ctx.log.error('failed to release shopify sync claim', releaseError as Error, {
            connectionId: connection.id,
          })
        }
      }
      if (syncSummary.deadlineReached) {
        ctx.log.info('connection stopped early on time budget; remaining rows resume next run', {
          connectionId: connection.id,
        })
      }
      results.push(toCronResult(
        connection.id,
        syncSummary,
        timedOutAfterSync ? 'error' : syncSummary.revoked ? 'revoked' : 'synced',
      ))
    } catch (error) {
      summary = commerceSyncFailureSummary(error)
      try {
        await releaseCommerceOrderSyncClaim(
          supabase,
          'shopify_connections',
          connection.id,
          claim.claimToken,
          cleanupDeadlineMs,
        )
      } catch (releaseError) {
        queuePersistenceError = releaseError as Error
        ctx.log.error('failed to release shopify sync claim', releaseError as Error, {
          connectionId: connection.id,
        })
      }
      ctx.log.error('shopify order sync failed for connection', error as Error, {
        connectionId: connection.id,
        companyId: connection.company_id,
      })
      results.push(toCronResult(connection.id, summary, 'error'))
      if (error instanceof CommerceSyncPersistenceError) {
        queuePersistenceError = error
      }
    }

    if (queuePersistenceError) {
      for (const unstarted of selection.claims.slice(index + 1)) {
        try {
          await restoreCommerceOrderSyncClaim(
            supabase,
            'shopify_connections',
            unstarted,
            cleanupDeadlineMs,
          )
        } catch (restoreError) {
          ctx.log.error('failed to restore unstarted shopify sync claim', restoreError as Error, {
            connectionId: unstarted.connection.id,
          })
        }
      }
      break
    }
  }

  if (queuePersistenceError) {
    const totalImported = results.reduce((acc, result) => acc + result.imported, 0)
    const totalDuplicates = results.reduce((acc, result) => acc + result.duplicates, 0)
    const totalErrors = results.reduce((acc, result) => acc + result.errors, 0)
    return NextResponse.json(
      {
        error: {
          code: 'COMMERCE_SYNC_PERSISTENCE_FAILED',
          message: 'Synkroniseringens beständiga status kunde inte säkerställas.',
          message_en: 'The durable sync state could not be confirmed.',
          requestId: ctx.requestId,
        },
        processed: results.length,
        imported: totalImported,
        duplicates: totalDuplicates,
        errors: totalErrors,
        results,
      },
      { status: 500 },
    )
  }

  if (workTimedOut) return selectionTimeoutResponse(results)

  const totalImported = results.reduce((acc, r) => acc + r.imported, 0)
  const totalDuplicates = results.reduce((acc, r) => acc + r.duplicates, 0)
  const totalErrors = results.reduce((acc, r) => acc + r.errors, 0)
  ctx.log.info('shopify order sync summary', {
    processed: results.length,
    totalImported,
    failed: results.filter((r) => r.status === 'error').length,
  })

  return NextResponse.json({
    processed: results.length,
    imported: totalImported,
    duplicates: totalDuplicates,
    errors: totalErrors,
    results,
  })
})
