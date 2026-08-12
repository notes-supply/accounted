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
import { loadCategorizationCompanySettings } from '@/lib/bookkeeping/company-settings'
import {
  getTemplateById,
  buildMappingResultFromTemplate,
  validateTemplateForEntity,
} from '@/lib/bookkeeping/booking-templates'
import { buildMappingResultFromCounterpartyTemplate } from '@/lib/bookkeeping/counterparty-templates'
import { createTransactionJournalEntry } from '@/lib/bookkeeping/transaction-entries'
import {
  attachCategorizedTransaction,
  compensatePostCommitReadbackFailure,
} from '@/lib/transactions/settlement-attachment'
import {
  existingCategorizationMappingFields,
  verifyExistingCategorization,
} from '@/lib/transactions/existing-categorization'
import { AccountsNotInChartError, isBookkeepingError } from '@/lib/bookkeeping/errors'
import { collectMappingResultAccounts, findUnresolvableAccounts } from '@/lib/bookkeeping/account-validation'
import { getErrorMessage } from '@/lib/errors/get-error-message'
import { eventBus } from '@/lib/events'
import type { Logger } from '@/lib/logger'
import type {
  CategorizationTemplate,
  EntityType,
  Transaction,
  TransactionCategory,
} from '@/types'

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

  if (transaction.journal_entry_id) {
    const mappingAffectingFields = existingCategorizationMappingFields(input)

    if (mappingAffectingFields.length > 0) {
      return {
        ok: false,
        request_index: index,
        transaction_id: transactionId,
        error: {
          code: 'TX_CATEGORIZE_ALREADY_POSTED_MAPPING_CHANGE',
          message: 'The posted journal entry cannot be changed by categorization.',
          details: { fields: mappingAffectingFields },
        },
      }
    }

    const requestedCategory: TransactionCategory = input.is_business
      ? input.category || 'uncategorized'
      : 'private'
    const verification = await verifyExistingCategorization(supabase, {
      companyId,
      transaction: transaction as Transaction & { journal_entry_id: string },
      requestedCategory,
      requestedIsBusiness: input.is_business,
    })
    if (!verification.ok) {
      return {
        ok: false,
        request_index: index,
        transaction_id: transactionId,
        error: verification.kind === 'database_error'
          ? {
              code: 'BOOKKEEPING_DATABASE_ERROR',
              message: getErrorMessage(verification.error),
              details: {
                operation: 'verify_existing_transaction_categorization',
              },
            }
          : {
              code: 'TX_CATEGORIZE_RACE',
              message: 'Existing posted categorization could not be proven coherent.',
              details: { reason: verification.reason },
            },
      }
    }

    return {
      ok: true,
      request_index: index,
      transaction_id: transactionId,
      data: {
        journal_entry_created: false,
        journal_entry_id: transaction.journal_entry_id,
        category: requestedCategory,
        already_had_journal_entry: true,
      },
    }
  }

  let settlementAccount: string
  try {
    settlementAccount = await resolveSettlementAccount(
      supabase,
      companyId,
      transaction.cash_account_id ?? null,
      log,
    )
  } catch (error) {
    return {
      ok: false,
      request_index: index,
      transaction_id: transactionId,
      error: {
        code: 'BOOKKEEPING_DATABASE_ERROR',
        message: getErrorMessage(error),
      },
    }
  }

  const { is_business, category } = input
  if (
    (input.counterparty_template_id && !is_business) ||
    (input.account_override && !is_business) ||
    (input.counterparty_template_id && input.template_id) ||
    (input.account_override && (input.template_id || input.counterparty_template_id))
  ) {
    return {
      ok: false,
      request_index: index,
      transaction_id: transactionId,
      error: {
        code: 'VALIDATION_ERROR',
        message: 'Unsupported categorization input combination.',
      },
    }
  }

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
  if (input.counterparty_template_id) {
    const { data: counterpartyTemplate, error: counterpartyTemplateError } = await supabase
      .from('categorization_templates')
      .select('*')
      .eq('id', input.counterparty_template_id)
      .eq('company_id', companyId)
      .eq('is_active', true)
      .maybeSingle()
    if (counterpartyTemplateError) {
      return {
        ok: false,
        request_index: index,
        transaction_id: transactionId,
        error: {
          code: 'BOOKKEEPING_DATABASE_ERROR',
          message: getErrorMessage(counterpartyTemplateError),
        },
      }
    }
    if (!counterpartyTemplate) {
      return {
        ok: false,
        request_index: index,
        transaction_id: transactionId,
        error: {
          code: 'NOT_FOUND',
          message: 'Counterparty template not found.',
          details: { resource: 'counterparty_template' },
        },
      }
    }
    mappingResult = buildMappingResultFromCounterpartyTemplate(
      {
        template: counterpartyTemplate as CategorizationTemplate,
        matchMethod: 'exact_alias',
        confidence: Number(counterpartyTemplate.confidence),
      },
      transaction as Transaction,
      entityType,
    )
  } else if (input.template_id) {
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
  mappingResult = applySettlementAccount(mappingResult, settlementAccount, transaction.amount)

  if (input.account_override) {
    const { data: accountExists, error: accountError } = await supabase
      .from('chart_of_accounts')
      .select('account_number, account_class')
      .eq('company_id', companyId)
      .eq('account_number', input.account_override)
      .eq('is_active', true)
      .single()
    if (accountError && accountError.code !== 'PGRST116') {
      return {
        ok: false,
        request_index: index,
        transaction_id: transactionId,
        error: {
          code: 'BOOKKEEPING_DATABASE_ERROR',
          message: getErrorMessage(accountError),
        },
      }
    }
    if (!accountExists) {
      return {
        ok: false,
        request_index: index,
        transaction_id: transactionId,
        error: {
          code: 'TX_CATEGORIZE_INVALID_ACCOUNT',
          message: 'Account override is not active in the company chart.',
          details: { accountNumber: input.account_override },
        },
      }
    }

    if (transaction.amount < 0) mappingResult.debit_account = input.account_override
    else mappingResult.credit_account = input.account_override

    const overrideNumber = parseInt(input.account_override, 10)
    const isVatLineAccount = overrideNumber >= 2610 && overrideNumber <= 2649
    if (accountExists.account_class === 2 && !isVatLineAccount) {
      mappingResult.vat_lines = []
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

  // Pre-validate every account in the mapping against the company's
  // chart_of_accounts. Templates and category defaults can reference accounts
  // that aren't activated in this company's kontoplan; without this check the
  // engine throws AccountsNotInChartError mid-flight and the legacy
  // partial-success branch silently marks the row bokförd with no
  // verifikation. Validate in both dry-run and live paths so previews
  // surface the same actionable error. Standard BAS accounts merely absent
  // from the chart pass: the engine seeds them on demand.
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
          would_create_journal_entry: !transaction.journal_entry_id,
        },
      },
    }
  }

  // Period-lock pre-check: same rationale as the single :categorize route.
  // A locked period surfaces as PERIOD_LOCKED on the per-item error rather
  // than a generic INTERNAL_ERROR from the trigger exception.
  const periodLock = await checkPeriodLock(supabase, companyId, transaction.date)
  if (periodLock.locked) {
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

  let journalEntryId: string | null = null
  let journalEntryError: string | null = null
  try {
    const je = await createTransactionJournalEntry(
      supabase,
      companyId,
      userId,
      transaction as Transaction,
      mappingResult,
      undefined,
      { category: finalCategory, isBusiness: is_business },
    )
    if (je) journalEntryId = je.id
  } catch (err) {
    log.error('batch-categorize: journal entry creation failed', err as Error, {
      request_index: index,
      transactionId,
    })
    const postCommitFailure = await compensatePostCommitReadbackFailure(
      supabase,
      { companyId, userId, transactionId, error: err },
      log,
    )
    if (postCommitFailure.handled) {
      return {
        ok: false,
        request_index: index,
        transaction_id: transactionId,
        error: {
          code: 'BOOKKEEPING_DATABASE_ERROR',
          message: 'Posted journal entry readback failed.',
          details: {
            operation: 'commit_entry.readback',
            journal_entry_id: postCommitFailure.journalEntryId,
            voucher_number: postCommitFailure.voucherNumber,
            compensation_verified: postCommitFailure.compensationVerified,
            ...(postCommitFailure.partialPostedIds
              ? { partial_posted_ids: postCommitFailure.partialPostedIds }
              : {}),
          },
        },
      }
    }
    // AccountsNotInChartError means an account was deactivated between our
    // pre-validation and the engine call (rare race). Return the per-item
    // failure WITHOUT the transaction update below so the row stays in
    // "Att bokföra": partial-success on a missing-account error would
    // mark it bokförd with no verifikation.
    if (err instanceof AccountsNotInChartError) {
      return {
        ok: false,
        request_index: index,
        transaction_id: transactionId,
        error: {
          code: 'ACCOUNTS_NOT_IN_CHART',
          message: `Följande konton behöver aktiveras: ${err.accountNumbers.join(', ')}`,
          details: { account_numbers: err.accountNumbers },
        },
      }
    }
    if (isBookkeepingError(err)) {
      journalEntryError = getErrorMessage(err, { context: 'transaction' })
    } else {
      journalEntryError = err instanceof Error ? err.message : 'Unknown error'
    }
  }

  if (!journalEntryId) {
    return {
      ok: false,
      request_index: index,
      transaction_id: transactionId,
      error: {
        code: 'BOOKKEEPING_DATABASE_ERROR',
        message: journalEntryError ?? 'Journal entry creation returned no durable id.',
        details: { operation: 'create_transaction_journal_entry' },
      },
    }
  }

  const attachment = await attachCategorizedTransaction(
    supabase,
    {
      companyId,
      userId,
      transactionId,
      expectedJournalEntryId: transaction.journal_entry_id ?? null,
      expectedCashAccountId: transaction.cash_account_id ?? null,
      expectedSettlementAccount: settlementAccount,
      isBusiness: is_business,
      category: finalCategory,
      journalEntryId,
      requireVerifiedTransaction: true,
    },
    log,
  )
  if (!attachment.ok && attachment.reason === 'database_error') {
    return {
      ok: false,
      request_index: index,
      transaction_id: transactionId,
      error: {
        code: 'BOOKKEEPING_DATABASE_ERROR',
        message: getErrorMessage(attachment.error),
        ...(attachment.partialPostedIds
          ? { details: { partial_posted_ids: attachment.partialPostedIds } }
          : {}),
      },
    }
  }
  if (!attachment.ok) {
    return {
      ok: false,
      request_index: index,
      transaction_id: transactionId,
      error: {
        code: 'TX_CATEGORIZE_RACE',
        message: 'Concurrent state change.',
        ...(attachment.partialPostedIds
          ? { details: { partial_posted_ids: attachment.partialPostedIds } }
          : {}),
      },
    }
  }

  const verifiedTransaction = attachment.verifiedTransaction
  if (!verifiedTransaction) {
    return {
      ok: false,
      request_index: index,
      transaction_id: transactionId,
      error: {
        code: 'BOOKKEEPING_DATABASE_ERROR',
        message: 'Post-attachment transaction state could not be verified.',
      },
    }
  }

  try {
    await eventBus.emit({
      type: 'transaction.categorized',
      payload: {
        transaction: verifiedTransaction,
        account: mappingResult.debit_account,
        taxCode: mappingResult.vat_lines[0]?.account_number || '',
        userId,
        companyId,
      },
    })
  } catch (err) {
    log.warn('batch-categorize: event emit failed (non-critical)', err as Error)
  }

  return {
    ok: true,
    request_index: index,
    transaction_id: transactionId,
    data: {
      journal_entry_created: !!journalEntryId,
      journal_entry_id: journalEntryId,
      journal_entry_error: journalEntryError,
      category: finalCategory,
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

    const { entityType } = await loadCategorizationCompanySettings(
      ctx.supabase,
      ctx.companyId!,
    )

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
