/**
 * POST /api/v1/companies/{companyId}/transactions/batch-categorize
 *
 * Apply a single categorization to up to 100 transactions in one call.
 * Partial-success semantics: per-item failure does not roll back items
 * that succeeded. Each item is processed through the same orchestration
 * as the single :categorize endpoint, so it can fail individually for any
 * of the same reasons (invalid template, invalid mapping, race, etc.).
 *
 * Idempotent over the whole batch. Dry-runnable.
 */
import { z } from 'zod'
import { ok } from '@/lib/api/v1/response'
import { dryRunPreview } from '@/lib/api/v1/dry-run'
import { registerEndpoint, dataEnvelope } from '@/lib/api/v1/registry'
import { withApiV1 } from '@/lib/api/v1/with-api-v1'
import { v1ErrorResponseFromCode } from '@/lib/api/v1/errors'
import { checkPeriodLock } from '@/lib/api/v1/check-period-lock'
import { CategorizeTransactionSchema } from '@/lib/api/schemas'
import type { SupabaseClient } from '@supabase/supabase-js'
import { buildMappingResultFromCategory } from '@/lib/bookkeeping/category-mapping'
import { applySettlementAccount } from '@/lib/bookkeeping/mapping-engine'
import { resolveSettlementAccount } from '@/lib/bookkeeping/settlement-account'
import {
  getTemplateById,
  buildMappingResultFromTemplate,
  validateTemplateForEntity,
} from '@/lib/bookkeeping/booking-templates'
import { categorizeResolvedTransaction } from '@/lib/transactions/categorize-core'
import { hasLiveJournalEntryLink } from '@/lib/transactions/link-journal-entry'
import { AccountsNotInChartError, isBookkeepingError } from '@/lib/bookkeeping/errors'
import { collectMappingResultAccounts, findUnresolvableAccounts } from '@/lib/bookkeeping/account-validation'
import { getErrorMessage } from '@/lib/errors/get-error-message'
import type { Logger } from '@/lib/logger'
import type { EntityType, Transaction, TransactionCategory } from '@/types'

const BatchItem = z.object({
  transaction_id: z.string().uuid(),
  categorization: CategorizeTransactionSchema,
})

const BatchRequest = z.object({
  items: z.array(BatchItem).min(1).max(100),
  all_or_nothing: z.boolean().optional().default(false),
})

const ResultItem = z.object({
  ok: z.boolean(),
  request_index: z.number().int().nonnegative(),
  transaction_id: z.string().uuid(),
  data: z.unknown().optional(),
  error: z
    .object({
      code: z.string(),
      message: z.string(),
      details: z.unknown().optional(),
    })
    .optional(),
})

const BatchResponse = z.object({
  results: z.array(ResultItem),
  summary: z.object({
    total: z.number().int(),
    succeeded: z.number().int(),
    failed: z.number().int(),
  }),
})

registerEndpoint({
  operation: 'transactions.batch-categorize',
  method: 'POST',
  path: '/api/v1/companies/:companyId/transactions/batch-categorize',
  summary: 'Categorize up to 100 transactions in one call (partial-success).',
  description:
    'Per-item categorization mirroring the single :categorize endpoint. Same `{ results, summary }` shape as the other bulk endpoints. all_or_nothing: true returns 501 NOT_IMPLEMENTED. Idempotent over the whole batch.',
  useWhen:
    'You have many transactions to categorize with the same logic (e.g. apply a booking template across a queue, mark a batch as private, override accounts on a series).',
  doNotUseFor:
    'Categorizing transactions with mixed logic: make multiple :categorize calls. Auto-categorization via templates: handled inside `ingest` for matching rows, no separate endpoint needed.',
  pitfalls: [
    'Max 100 items per call. Sequential processing.',
    'Idempotency-Key covers the WHOLE batch: replays return the cached full response.',
    'all_or_nothing: true returns 501 NOT_IMPLEMENTED. Today only partial-success batches exist.',
  ],
  example: {
    request: {
      items: [
        { transaction_id: 'tx_1', categorization: { is_business: true, category: 'expense_office' } },
      ],
    },
    response: {
      data: {
        results: [{ ok: true, request_index: 0, transaction_id: 'tx_1', data: { journal_entry_id: 'je_…' } }],
        summary: { total: 1, succeeded: 1, failed: 0 },
      },
      meta: { request_id: 'req_…', api_version: '2026-05-12' },
    },
  },
  scope: 'transactions:write',
  risk: 'medium',
  idempotent: true,
  reversible: true,
  dryRunSupported: true,
  request: { body: BatchRequest },
  response: { success: dataEnvelope(BatchResponse) },
})

interface Item {
  ok: boolean
  request_index: number
  transaction_id: string
  data?: unknown
  error?: { code: string; message: string; details?: unknown }
}

async function categorizeOne(
  supabase: SupabaseClient,
  companyId: string,
  userId: string,
  entityType: EntityType,
  index: number,
  transactionId: string,
  input: z.infer<typeof CategorizeTransactionSchema>,
  dryRun: boolean,
  log: Logger,
): Promise<Item> {
  const { data: transaction, error: fetchErr } = await supabase
    .from('transactions')
    .select('*')
    .eq('id', transactionId)
    .eq('company_id', companyId)
    .single()
  if (fetchErr || !transaction) {
    return {
      ok: false,
      request_index: index,
      transaction_id: transactionId,
      error: { code: 'TX_CATEGORIZE_TX_NOT_FOUND', message: 'Transaction not found.' },
    }
  }

  const { is_business, category } = input
  let finalCategory: TransactionCategory
  if (input.template_id) {
    const template = getTemplateById(input.template_id)
    if (!template) {
      return {
        ok: false,
        request_index: index,
        transaction_id: transactionId,
        error: {
          code: 'TX_CATEGORIZE_INVALID_TEMPLATE',
          message: 'Unknown template id.',
          details: { templateId: input.template_id },
        },
      }
    }
    const valid = validateTemplateForEntity(template, entityType)
    if (!valid.valid) {
      return {
        ok: false,
        request_index: index,
        transaction_id: transactionId,
        error: {
          code: 'TX_CATEGORIZE_INVALID_TEMPLATE',
          message: 'Template not valid for entity type.',
          details: { templateId: input.template_id, reason: valid.error },
        },
      }
    }
    finalCategory = is_business ? template.fallback_category : 'private'
  } else {
    finalCategory = is_business ? category || 'uncategorized' : 'private'
  }

  let mappingResult
  if (input.template_id) {
    const template = getTemplateById(input.template_id)!
    mappingResult = buildMappingResultFromTemplate(template, transaction as Transaction, entityType)
  } else {
    mappingResult = buildMappingResultFromCategory(
      finalCategory,
      transaction as Transaction,
      is_business,
      entityType,
      input.vat_treatment,
    )
  }
  let settlementAccount: string
  try {
    settlementAccount = await resolveSettlementAccount(
      supabase,
      companyId,
      transaction.cash_account_id,
      log,
    )
    mappingResult = applySettlementAccount(mappingResult, settlementAccount)
  } catch (err) {
    log.error('batch-categorize: settlement account lookup failed', err as Error, {
      request_index: index,
      transactionId,
    })
    return {
      ok: false,
      request_index: index,
      transaction_id: transactionId,
      error: {
        code: 'INTERNAL_ERROR',
        message: isBookkeepingError(err) ? getErrorMessage(err, { context: 'transaction' }) : getErrorMessage(err),
      },
    }
  }
  // Dimensions: an explicitly supplied bag tags the business lines of the
  // generated verifikat (bank/VAT legs stay untagged).
  if (input.dimensions && Object.keys(input.dimensions).length > 0) {
    mappingResult.dimensions = input.dimensions
  }
  if (!mappingResult.debit_account || !mappingResult.credit_account) {
    return {
      ok: false,
      request_index: index,
      transaction_id: transactionId,
      error: {
        code: 'TX_CATEGORIZE_INVALID_MAPPING',
        message: 'Could not resolve debit/credit accounts.',
      },
    }
  }

  // Pre-validate every account in the mapping against the company's chart.
  // Templates and category defaults can reference inactive custom accounts.
  // Without this guard they would reach the engine and fail during posting.
  // Validate in both dry-run and live paths so previews surface the same
  // actionable error. Standard BAS accounts merely absent from the chart pass
  // are seeded by the engine on demand.
  const missingAccounts = await findUnresolvableAccounts(
    supabase,
    companyId,
    collectMappingResultAccounts(mappingResult),
  )
  if (missingAccounts.length > 0) {
    return {
      ok: false,
      request_index: index,
      transaction_id: transactionId,
      error: {
        code: 'ACCOUNTS_NOT_IN_CHART',
        message: `Följande konton behöver aktiveras: ${missingAccounts.join(', ')}`,
        details: { account_numbers: missingAccounts },
      },
    }
  }

  const existingCategorization = Boolean(
    transaction.journal_entry_id &&
    await hasLiveJournalEntryLink(supabase, companyId, transaction.journal_entry_id),
  )

  if (dryRun) {
    return {
      ok: true,
      request_index: index,
      transaction_id: transactionId,
      data: {
        preview: {
          category: finalCategory,
          debit_account: mappingResult.debit_account,
          credit_account: mappingResult.credit_account,
          vat_lines: mappingResult.vat_lines,
          would_create_journal_entry: !existingCategorization,
        },
      },
    }
  }


  // Period-lock pre-check: same rationale as the single :categorize route.
  // A locked period surfaces as PERIOD_LOCKED on the per-item error rather
  // than a generic INTERNAL_ERROR from the trigger exception.
  const periodLock = await checkPeriodLock(supabase, companyId, transaction.date)
  if (!existingCategorization && periodLock.locked) {
    return {
      ok: false,
      request_index: index,
      transaction_id: transactionId,
      error: {
        code: 'PERIOD_LOCKED',
        message: 'Period is locked or closed; cannot post journal entry.',
        details: {
          transaction_date: transaction.date,
          reason: periodLock.reason,
          fiscal_period_id: periodLock.fiscal_period_id,
        },
      },
    }
  }

  let categorization
  try {
    categorization = await categorizeResolvedTransaction(
      supabase,
      userId,
      companyId,
      {
        transaction: transaction as Transaction,
        mappingResult,
        category: finalCategory,
        isBusiness: is_business,
        settlementAccount,
        existingCategorization,
      },
    )
  } catch (error) {
    log.error('batch-categorize: verified coordinator failed', error as Error, {
      request_index: index,
      transactionId,
    })
    return {
      ok: false,
      request_index: index,
      transaction_id: transactionId,
      error: {
        code: error instanceof AccountsNotInChartError
          ? 'ACCOUNTS_NOT_IN_CHART'
          : 'INTERNAL_ERROR',
        message: isBookkeepingError(error)
          ? getErrorMessage(error, { context: 'transaction' })
          : getErrorMessage(error),
        ...(error instanceof AccountsNotInChartError
          ? { details: { account_numbers: error.accountNumbers } }
          : {}),
      },
    }
  }

  if (categorization.error) {
    return {
      ok: false,
      request_index: index,
      transaction_id: transactionId,
      error: {
        code: categorization.errorCode ?? 'INTERNAL_ERROR',
        message: categorization.error,
        details: categorization.partialPostedIds
          ? {
              posted_ids: categorization.partialPostedIds,
              publication_ids: categorization.partialPublicationIds ?? [],
            }
          : undefined,
      },
    }
  }

  const alreadyHadJournalEntry =
    categorization.data?.already_had_journal_entry === true
  return {
    ok: true,
    request_index: index,
    transaction_id: transactionId,
    data: {
      journal_entry_created: !alreadyHadJournalEntry,
      journal_entry_id: categorization.data?.journal_entry_id,
      journal_entry_error: null,
      category: finalCategory,
      ...(alreadyHadJournalEntry ? { already_had_journal_entry: true } : {}),
    },
  }
}

export const POST = withApiV1<{ params: Promise<{ companyId: string }> }>(
  'transactions.batch-categorize',
  async (request, ctx) => {
    let rawBody: unknown
    try {
      rawBody = await request.json()
    } catch {
      return v1ErrorResponseFromCode('VALIDATION_ERROR', ctx.log, {
        requestId: ctx.requestId,
        details: { field: 'body', message: 'Body is not valid JSON.' },
      })
    }
    const parsed = BatchRequest.safeParse(rawBody)
    if (!parsed.success) {
      return v1ErrorResponseFromCode('VALIDATION_ERROR', ctx.log, {
        requestId: ctx.requestId,
        details: {
          issues: parsed.error.issues.map((i) => ({
            field: i.path.join('.'),
            message: i.message,
          })),
        },
      })
    }
    const body = parsed.data

    if (body.all_or_nothing) {
      return v1ErrorResponseFromCode('NOT_IMPLEMENTED', ctx.log, {
        requestId: ctx.requestId,
        details: {
          field: 'all_or_nothing',
          message: 'Use partial-success semantics (omit the flag or pass false).',
        },
      })
    }

    const { data: settings } = await ctx.supabase
      .from('company_settings')
      .select('entity_type')
      .eq('company_id', ctx.companyId!)
      .single()
    const entityType: EntityType =
      (settings?.entity_type as EntityType) || 'enskild_firma'

    const results: Item[] = []
    for (let i = 0; i < body.items.length; i++) {
      const item = body.items[i]
      const r = await categorizeOne(
        ctx.supabase,
        ctx.companyId!,
        ctx.userId,
        entityType,
        i,
        item.transaction_id,
        item.categorization,
        ctx.dryRun,
        ctx.log,
      )
      results.push(r)
    }

    const summary = {
      total: results.length,
      succeeded: results.filter((r) => r.ok).length,
      failed: results.filter((r) => !r.ok).length,
    }

    if (ctx.dryRun) {
      return dryRunPreview({ results, summary }, { requestId: ctx.requestId, log: ctx.log })
    }
    return ok({ results, summary }, { requestId: ctx.requestId })
  },
  { requireIdempotencyKey: true },
)
