import { NextResponse } from 'next/server'
import { ensureInitialized } from '@/lib/init'
import { withCronContext } from '@/lib/api/with-cron-context'
import { createServiceClient } from '@/lib/supabase/server'
import { huntCompany, resolveAllowlist } from '@/lib/receipt-hunt/hunt'
import { hasCapability } from '@/lib/entitlements/has-capability'
import { CAPABILITY } from '@/lib/entitlements/keys'

ensureInitialized()

export const RECEIPT_HUNT_ROUTE_BUDGET_MS = 300_000
export const RECEIPT_HUNT_SAFETY_MARGIN_MS = 15_000
export const RECEIPT_HUNT_COMPANY_BUDGET_MS = 60_000

class ReceiptHuntDeadlineError extends Error {}

async function withDeadline<T>(
  parentSignal: AbortSignal,
  timeoutMs: number,
  task: (signal: AbortSignal, deadlineAt: string) => Promise<T>,
): Promise<T> {
  const controller = new AbortController()
  const signal = AbortSignal.any([parentSignal, controller.signal])
  const deadlineAt = new Date(Date.now() + timeoutMs).toISOString()
  const timer = setTimeout(() => {
    controller.abort(new ReceiptHuntDeadlineError('Receipt hunt company timed out'))
  }, timeoutMs)

  try {
    const result = await task(signal, deadlineAt)
    if (signal.aborted) {
      throw signal.reason instanceof Error
        ? signal.reason
        : new ReceiptHuntDeadlineError('Receipt hunt company deadline exceeded')
    }
    return result
  } finally {
    clearTimeout(timer)
  }
}

/**
 * GET /api/receipt-hunt/cron, daily 05:30 UTC.
 *
 * Pairs unbooked card purchases that have no receipt with the unconsumed
 * underlag the company already holds, and stages each pairing for approval.
 * Runs after the 05:00 bank sync so the night's new transactions are swept the
 * same morning.
 *
 * Writes nothing to the journal: every pairing becomes an
 * `attach_document_to_transaction` pending operation, and the document only
 * reaches a verifikat later, when the user books the transaction.
 *
 * Scoped to `RECEIPT_HUNT_COMPANY_IDS` while the feature is piloted. Unset
 * means the hunt runs for nobody, so a deploy cannot silently start staging
 * proposals in every company at once.
 */
export const GET = withCronContext('cron.receipt_hunt', async (_request, ctx) => {
  const companyIds = resolveAllowlist(process.env.RECEIPT_HUNT_COMPANY_IDS)
  if (companyIds.length === 0) {
    ctx.log.info('receipt hunt skipped: no companies allowlisted')
    return NextResponse.json({
      success: true,
      skipped: true,
      reason: 'RECEIPT_HUNT_COMPANY_IDS is empty',
      total: 0,
    })
  }

  const supabase = createServiceClient()
  const runId = crypto.randomUUID()

  ctx.log.info('receipt hunt starting', { companyCount: companyIds.length, runId })

  const results: Array<{
    companyId: string
    candidates: number
    poolSize: number
    proposed: number
    skippedNoAiEntitlement?: boolean
  }> = []
  const summary = {
    total: companyIds.length,
    succeeded: 0,
    failed: 0,
    failures: [] as Array<{ index: number; error: string }>,
  }
  const globalController = new AbortController()
  const globalBudgetMs = RECEIPT_HUNT_ROUTE_BUDGET_MS - RECEIPT_HUNT_SAFETY_MARGIN_MS
  const globalDeadlineAt = Date.now() + globalBudgetMs
  const globalTimer = setTimeout(() => {
    globalController.abort(new ReceiptHuntDeadlineError('Receipt hunt global deadline exceeded'))
  }, globalBudgetMs)

  try {
    for (let index = 0; index < companyIds.length; index++) {
      const companyId = companyIds[index]
      const remainingMs = globalDeadlineAt - Date.now()
      if (remainingMs <= 0 || globalController.signal.aborted) {
        for (let rest = index; rest < companyIds.length; rest++) {
          summary.failed++
          summary.failures.push({ index: rest, error: 'Receipt hunt global deadline exceeded' })
        }
        break
      }

      try {
        const result = await withDeadline(
          globalController.signal,
          Math.min(RECEIPT_HUNT_COMPANY_BUDGET_MS, remainingMs),
          async (signal, deadlineAt) => {
            const entitled = await hasCapability(supabase, companyId, CAPABILITY.ai)
            if (signal.aborted) throw signal.reason
            if (!entitled) {
              return {
                companyId,
                candidates: 0,
                poolSize: 0,
                proposed: 0,
                skippedNoAiEntitlement: true,
              }
            }
            // Production mailbox search stays disabled until resumable provider
            // checkpoints prove it can finish inside this route budget.
            const hunted = await huntCompany(supabase, companyId, runId, {
              searchMail: false,
              signal,
              deadlineAt,
            })
            return {
              companyId: hunted.companyId,
              candidates: hunted.candidates,
              poolSize: hunted.poolSize,
              proposed: hunted.proposed,
            }
          },
        )
        results.push(result)
        summary.succeeded++
      } catch (error) {
        summary.failed++
        summary.failures.push({
          index,
          error: error instanceof ReceiptHuntDeadlineError
            ? 'RECEIPT_HUNT_DEADLINE_EXCEEDED'
            : 'RECEIPT_HUNT_COMPANY_FAILED',
        })
        ctx.log.error('receipt hunt failed for company', error as Error, { companyId })
      }
    }
  } finally {
    clearTimeout(globalTimer)
  }

  const proposed = results.reduce((sum, r) => sum + r.proposed, 0)
  ctx.log.info('receipt hunt summary', {
    runId,
    total: summary.total,
    succeeded: summary.succeeded,
    failed: summary.failed,
    proposed,
  })

  return NextResponse.json({
    success: true,
    runId,
    total: summary.total,
    succeeded: summary.succeeded,
    failed: summary.failed,
    failures: summary.failures,
    proposed,
    results,
  })
})

export const POST = GET

/** Sequential companies share a 285-second deadline and each gets at most 60 seconds. */
export const maxDuration = 300
