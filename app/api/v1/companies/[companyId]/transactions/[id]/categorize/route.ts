/**
 * POST /api/v1/companies/{companyId}/transactions/{id}/categorize
 *
 * Categorize a transaction and create the corresponding journal entry. This
 * is a thin v1 surface over the same orchestration the internal dashboard
 * route uses: same mapping engine, same booking templates, same SI-match
 * suggestion intercept, and the same atomic settlement attachment guard.
 *
 * Already-categorized fast path: the coordinator verifies the immutable
 * category, business flag, settlement provenance, and journal lines. Only an
 * exact match returns as a no-op; mismatches are conflicts.
 *
 * Dry-runnable: returns the resolved mapping (debit/credit + VAT lines)
 * without inserting the journal entry or mutating the transaction.
 */
import { z } from 'zod'
import { ok } from '@/lib/api/v1/response'
import { dryRunPreview } from '@/lib/api/v1/dry-run'
import { registerEndpoint, dataEnvelope } from '@/lib/api/v1/registry'
import { withApiV1 } from '@/lib/api/v1/with-api-v1'
import { v1ErrorResponse, v1ErrorResponseFromCode } from '@/lib/api/v1/errors'
import { checkPeriodLock } from '@/lib/api/v1/check-period-lock'
import { CategorizeTransactionSchema } from '@/lib/api/schemas'
import { buildMappingResultFromCategory } from '@/lib/bookkeeping/category-mapping'
import {
  getTemplateById,
  buildMappingResultFromTemplate,
  validateTemplateForEntity,
} from '@/lib/bookkeeping/booking-templates'
import { buildMappingResultFromCounterpartyTemplate } from '@/lib/bookkeeping/counterparty-templates'
import { categorizeResolvedTransaction } from '@/lib/transactions/categorize-core'
import { hasLiveJournalEntryLink } from '@/lib/transactions/link-journal-entry'
import { saveUserMappingRule, applySettlementAccount } from '@/lib/bookkeeping/mapping-engine'
import { resolveSettlementAccount } from '@/lib/bookkeeping/settlement-account'
import { AccountsNotInChartError } from '@/lib/bookkeeping/errors'
import { collectMappingResultAccounts, findUnresolvableAccounts } from '@/lib/bookkeeping/account-validation'
import type {
  CategorizationTemplate,
  EntityType,
  Transaction,
  TransactionCategory,
} from '@/types'

const CategorizeResponse = z.object({
  success: z.boolean(),
  journal_entry_created: z.boolean(),
  journal_entry_id: z.string().uuid().nullable(),
  journal_entry_error: z.string().nullable(),
  document_link_warning: z.string().nullable().optional(),
  category: z.string(),
  already_had_journal_entry: z.boolean().optional(),
})

registerEndpoint({
  operation: 'transactions.categorize',
  method: 'POST',
  path: '/api/v1/companies/:companyId/transactions/:id/categorize',
  summary: 'Categorize a transaction and create the journal entry.',
  description:
    'Resolves the BAS account mapping for the transaction (via category, booking template, or counterparty template), creates the corresponding verifikation, and updates the transaction with is_business / category / journal_entry_id. Idempotent on (transaction, key). Dry-runnable.',
  useWhen:
    'You\'re categorizing a bank transaction. Pass `is_business: true` plus either `category`, `template_id` (booking template), `counterparty_template_id`, or `account_override`. For private transactions, `is_business: false` is enough.',
  doNotUseFor:
    'Matching a payment to an invoice: use `:match-invoice` or `:match-supplier-invoice`, which storno any conflicting JE first. Uncategorizing: `:uncategorize`.',
  pitfalls: [
    'A bank payment that looks like an invoice payment will be flagged via TX_CATEGORIZE_SUGGEST_SI_MATCH: pass `confirm_no_match: true` to override and force-categorize as direct expense (e.g. when the supplier invoice was already booked).',
    'Already-categorized fast path: a live journal_entry_id succeeds only when its immutable settlement snapshot exactly matches the request.',
    'account_override must exist in the chart of accounts; an unknown account returns TX_CATEGORIZE_INVALID_ACCOUNT.',
  ],
  example: {
    request: { is_business: true, category: 'expense_office' },
    response: {
      data: {
        success: true,
        journal_entry_created: true,
        journal_entry_id: 'je_…',
        category: 'expense_office',
      },
      meta: { request_id: 'req_…', api_version: '2026-05-12' },
    },
  },
  scope: 'transactions:write',
  risk: 'medium',
  idempotent: true,
  reversible: true,
  dryRunSupported: true,
  request: { body: CategorizeTransactionSchema },
  response: { success: dataEnvelope(CategorizeResponse) },
})

export const POST = withApiV1<{ params: Promise<{ companyId: string; id: string }> }>(
  'transactions.categorize',
  async (request, ctx, params) => {
    const { id } = await params.params
    const idParse = z.string().uuid().safeParse(id)
    if (!idParse.success) {
      return v1ErrorResponseFromCode('VALIDATION_ERROR', ctx.log, {
        requestId: ctx.requestId,
        details: { field: 'id', message: 'Transaction id must be a UUID.' },
      })
    }
    const txId = idParse.data

    let rawBody: unknown
    try {
      rawBody = await request.json()
    } catch {
      return v1ErrorResponseFromCode('VALIDATION_ERROR', ctx.log, {
        requestId: ctx.requestId,
        details: { field: 'body', message: 'Body is not valid JSON.' },
      })
    }
    const parsed = CategorizeTransactionSchema.safeParse(rawBody)
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
    const { is_business, category } = body

    const { data: transaction, error: fetchErr } = await ctx.supabase
      .from('transactions')
      .select('*')
      .eq('id', txId)
      .eq('company_id', ctx.companyId!)
      .single()

    if (fetchErr || !transaction) {
      return v1ErrorResponseFromCode('TX_CATEGORIZE_TX_NOT_FOUND', ctx.log, {
        requestId: ctx.requestId,
      })
    }

    const txLog = ctx.log.child({ transactionId: txId })

    const existingCategorization = Boolean(
      transaction.journal_entry_id &&
      await hasLiveJournalEntryLink(
        ctx.supabase,
        ctx.companyId!,
        transaction.journal_entry_id,
      ),
    )

    const { data: settings } = await ctx.supabase
      .from('company_settings')
      .select('entity_type')
      .eq('company_id', ctx.companyId!)
      .single()
    const entityType: EntityType = (settings?.entity_type as EntityType) || 'enskild_firma'

    // Resolve final category and mapping result. Mirrors the internal route.
    let finalCategory: TransactionCategory
    if (body.template_id) {
      const template = getTemplateById(body.template_id)
      if (!template) {
        return v1ErrorResponseFromCode('TX_CATEGORIZE_INVALID_TEMPLATE', txLog, {
          requestId: ctx.requestId,
          details: { templateId: body.template_id, reason: 'unknown_template' },
        })
      }
      const valid = validateTemplateForEntity(template, entityType)
      if (!valid.valid) {
        return v1ErrorResponseFromCode('TX_CATEGORIZE_INVALID_TEMPLATE', txLog, {
          requestId: ctx.requestId,
          details: { templateId: body.template_id, reason: valid.error },
        })
      }
      finalCategory = is_business ? template.fallback_category : 'private'
    } else {
      finalCategory = is_business ? category || 'uncategorized' : 'private'
    }

    let mappingResult
    if (body.counterparty_template_id && is_business) {
      const { data: cpTemplate } = await ctx.supabase
        .from('categorization_templates')
        .select('*')
        .eq('id', body.counterparty_template_id)
        .eq('company_id', ctx.companyId!)
        .eq('is_active', true)
        .maybeSingle()
      if (!cpTemplate) {
        return v1ErrorResponseFromCode('NOT_FOUND', txLog, {
          requestId: ctx.requestId,
          details: { resource: 'counterparty_template' },
        })
      }
      const match = {
        template: cpTemplate as CategorizationTemplate,
        matchMethod: 'exact_alias' as const,
        confidence: Number(cpTemplate.confidence),
      }
      mappingResult = buildMappingResultFromCounterpartyTemplate(
        match,
        transaction as Transaction,
        entityType,
      )
    } else if (body.template_id) {
      const template = getTemplateById(body.template_id)!
      mappingResult = buildMappingResultFromTemplate(
        template,
        transaction as Transaction,
        entityType,
      )
    } else {
      mappingResult = buildMappingResultFromCategory(
        finalCategory,
        transaction as Transaction,
        is_business,
        entityType,
        body.vat_treatment,
      )
    }

    // Book the bank leg against the transaction's ACTUAL settlement account
    // rather than the hardcoded 1930 in the templates. Without this, interest
    // or fees that landed on a savings/EUR account mis-book to 1930 and the
    // real bank line never reconciles. applySettlementAccount only rewrites a
    // 1930 leg and is a no-op when the settlement account is 1930, so legacy
    // rows with no cash_account_id behave exactly as before. Mirrors the
    // internal dashboard route (app/api/transactions/[id]/categorize); this
    // v1 surface previously never called applySettlementAccount at all.
    const settlementAccount = await resolveSettlementAccount(
      ctx.supabase,
      ctx.companyId!,
      transaction.cash_account_id,
      txLog,
    )
    mappingResult = applySettlementAccount(mappingResult, settlementAccount)

    if (
      is_business &&
      body.account_override &&
      !body.template_id &&
      !body.counterparty_template_id
    ) {
      const { data: accountExists } = await ctx.supabase
        .from('chart_of_accounts')
        .select('account_number, account_class')
        .eq('company_id', ctx.companyId!)
        .eq('account_number', body.account_override)
        .eq('is_active', true)
        .single()
      if (!accountExists) {
        return v1ErrorResponseFromCode('TX_CATEGORIZE_INVALID_ACCOUNT', txLog, {
          requestId: ctx.requestId,
          details: { accountNumber: body.account_override },
        })
      }
      if (transaction.amount < 0) mappingResult.debit_account = body.account_override
      else mappingResult.credit_account = body.account_override
      // Drop auto-VAT lines when the override targets a balance-sheet
      // (class 2) account, but NOT when it targets a moms-line account
      // directly. BAS class 2 covers both equity/liabilities (where VAT
      // shouldn't be auto-posted) and the specific VAT accounts themselves
      // (2611/2621/2631 utgående moms, 2641/2645 ingående moms, etc.).
      // Narrow the exception to the 2610-2649 range: 2650
      // (momsredovisningskonto) and 2690 (diverse) are class-2 but NOT
      // moms-line accounts, so writing the auto-VAT pair there would
      // double-post on the momsredovisningskonto.
      const overrideNum = parseInt(body.account_override, 10)
      const isMomsLineAccount = overrideNum >= 2610 && overrideNum <= 2649
      if (accountExists.account_class === 2 && !isMomsLineAccount) {
        mappingResult.vat_lines = []
      }
    }

    // Dimensions: an explicitly supplied bag tags the business lines of the
    // generated verifikat (bank/VAT legs stay untagged). Wins over a learned
    // counterparty-template bag; omitted = the learned bag (if any) applies.
    if (body.dimensions && Object.keys(body.dimensions).length > 0) {
      mappingResult.dimensions = body.dimensions
    }

    if (!mappingResult.debit_account || !mappingResult.credit_account) {
      return v1ErrorResponseFromCode('TX_CATEGORIZE_INVALID_MAPPING', txLog, {
        requestId: ctx.requestId,
        details: {
          debitAccount: mappingResult.debit_account,
          creditAccount: mappingResult.credit_account,
        },
      })
    }

    // Pre-validate every account in the mapping against the company's
    // chart_of_accounts. Template / counterparty-template / category paths
    // all bypass the older account_override check; without this catch they
    // would otherwise reach the engine and fail during posting. Validate in
    // both live and dry-run paths so previews surface the same actionable
    // error. Standard BAS accounts merely absent from the chart pass: the
    // engine seeds them.
    const missingAccounts = await findUnresolvableAccounts(
      ctx.supabase,
      ctx.companyId!,
      collectMappingResultAccounts(mappingResult),
    )
    if (missingAccounts.length > 0) {
      txLog.warn('mapping references inactive/unknown accounts', { missingAccounts })
      return v1ErrorResponse(new AccountsNotInChartError(missingAccounts), txLog, {
        requestId: ctx.requestId,
      })
    }

    // Dry-run stops here: caller sees the resolved mapping without burning
    // a voucher number or mutating any state.
    if (ctx.dryRun) {
      return dryRunPreview(
        {
          category: finalCategory,
          mapping: {
            debit_account: mappingResult.debit_account,
            credit_account: mappingResult.credit_account,
            vat_lines: mappingResult.vat_lines,
            all_lines_complete: mappingResult.all_lines_complete ?? false,
          },
          would_create_journal_entry: !existingCategorization,
          already_had_journal_entry: existingCategorization,
        },
        { requestId: ctx.requestId, log: ctx.log },
      )
    }

    // Period-lock pre-check. enforce_period_lock + enforce_company_lock_date
    // triggers will block the JE insert anyway, but they surface as a generic
    // 500. Catch the locked-period case here and return a structured
    // PERIOD_LOCKED response so callers see actionable error semantics.
    const periodLock = await checkPeriodLock(
      ctx.supabase,
      ctx.companyId!,
      transaction.date,
    )
    if (periodLock.locked) {
      return v1ErrorResponseFromCode('PERIOD_LOCKED', txLog, {
        requestId: ctx.requestId,
        details: {
          transaction_date: transaction.date,
          reason: periodLock.reason,
          fiscal_period_id: periodLock.fiscal_period_id,
        },
      })
    }

    const categorization = await categorizeResolvedTransaction(
      ctx.supabase,
      ctx.userId,
      ctx.companyId!,
      {
        transaction: transaction as Transaction,
        mappingResult,
        category: finalCategory,
        isBusiness: is_business,
        settlementAccount,
        existingCategorization,
      },
    )

    if (categorization.error) {
      if (categorization.partialPostedIds) {
        return v1ErrorResponse(new Error(categorization.error), txLog, {
          requestId: ctx.requestId,
          status: categorization.status ?? 500,
          details: {
            code: categorization.errorCode,
            posted_ids: categorization.partialPostedIds,
            publication_ids: categorization.partialPublicationIds ?? [],
          },
        })
      }
      return v1ErrorResponseFromCode('TX_CATEGORIZE_RACE', txLog, {
        requestId: ctx.requestId,
        details: { code: categorization.errorCode },
      })
    }

    const journalEntryId = categorization.data?.journal_entry_id as string
    const alreadyHadJournalEntry =
      categorization.data?.already_had_journal_entry === true
    if (
      !alreadyHadJournalEntry &&
      is_business &&
      transaction.merchant_name &&
      !mappingResult.direction_mismatch
    ) {
      try {
        await saveUserMappingRule(
          ctx.supabase,
          ctx.companyId!,
          transaction.merchant_name,
          mappingResult.debit_account,
          mappingResult.credit_account,
          !is_business,
          body.user_description,
          body.template_id,
        )
      } catch (err) {
        txLog.warn('save mapping rule failed after verified attachment', err as Error)
      }
    }

    return ok(
      {
        success: true,
        journal_entry_created: !alreadyHadJournalEntry,
        journal_entry_id: journalEntryId,
        journal_entry_error: null,
        category: finalCategory,
        ...(alreadyHadJournalEntry ? { already_had_journal_entry: true } : {}),
      },
      { requestId: ctx.requestId },
    )
  },
  { requireIdempotencyKey: true },
)
