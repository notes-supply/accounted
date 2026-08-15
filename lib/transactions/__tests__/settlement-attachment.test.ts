import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  createSettlementCoordinator,
  stageSettlementSnapshot,
} from '../settlement-attachment'
import type {
  SettlementAttachmentOutcome,
  SettlementCompensationOutcome,
  SettlementCoordinatorDependencies,
  SettlementPublicationIdentity,
  SettlementReadback,
  SettlementSnapshot,
} from '../settlement-attachment'
import { makeJournalEntry } from '@/tests/helpers'
import type { MappingResult, Transaction } from '@/types'

const transaction = {
  id: '00000000-0000-4000-8000-000000000001',
  company_id: '00000000-0000-4000-8000-000000000002',
  user_id: '00000000-0000-4000-8000-000000000003',
  journal_entry_id: null,
  cash_account_id: '00000000-0000-4000-8000-000000000004',
  date: '2026-08-15',
  description: 'Office purchase',
  amount: -125,
  amount_sek: null,
  currency: 'SEK',
  exchange_rate: null,
  category: 'uncategorized',
  is_business: null,
} as Transaction

const mappingResult = {
  rule: null,
  debit_account: '6110',
  credit_account: '1940',
  risk_level: 'LOW',
  confidence: 1,
  requires_review: false,
  default_private: false,
  vat_lines: [],
  description: 'Office purchase',
} as MappingResult

function exactReadback(snapshot: SettlementSnapshot, journalEntryId: string): SettlementReadback {
  return {
    transaction: {
      id: snapshot.transactionId,
      companyId: snapshot.companyId,
      journalEntryId,
      cashAccountId: snapshot.cashAccountId,
      amountSek: snapshot.amountSek,
      category: snapshot.category,
      isBusiness: snapshot.isBusiness,
    },
    journalEntry: {
      id: journalEntryId,
      companyId: snapshot.companyId,
      status: 'posted',
      sourceType: 'bank_transaction',
      sourceId: snapshot.transactionId,
      category: snapshot.category,
      isBusiness: snapshot.isBusiness,
      lines: snapshot.lines,
    },
    cashAccount: snapshot.cashAccountId
      ? {
          id: snapshot.cashAccountId,
          companyId: snapshot.companyId,
          ledgerAccount: snapshot.settlementAccount,
        }
      : null,
  }
}

function committedPublication(
  journalEntryId: string,
  publicationId = 'pub-committed',
): SettlementPublicationIdentity {
  return {
    publication_id: publicationId,
    event_key: `journal:${journalEntryId}:committed`,
    event_type: 'journal_entry.committed',
  }
}

function attachmentOutcome(
  snapshot: SettlementSnapshot,
  journalEntryId: string,
  publicationId = 'pub-committed',
): SettlementAttachmentOutcome {
  return {
    status: 'applied',
    company_id: snapshot.companyId,
    transaction_id: snapshot.transactionId,
    journal_entry_id: journalEntryId,
    readback: exactReadback(snapshot, journalEntryId),
    publication: committedPublication(journalEntryId, publicationId),
  }
}

function compensationOutcome(): SettlementCompensationOutcome {
  return {
    status: 'applied',
    company_id: transaction.company_id,
    transaction_id: transaction.id,
    root_journal_entry_id: 'je-original',
    original_journal_entry_id: 'je-original',
    reversal_journal_entry_id: 'je-storno',
    actor_type: 'user',
    actor_id: transaction.user_id,
    actor_label: null,
    publications: [
      {
        publication_id: 'pub-storno-committed',
        event_key: 'journal:je-storno:committed',
        event_type: 'journal_entry.committed',
      },
      {
        publication_id: 'pub-original-reversed',
        event_key: 'journal:je-original:reversed',
        event_type: 'journal_entry.reversed',
      },
    ],
  }
}

function dependencies(): SettlementCoordinatorDependencies {
  return {
    post: vi.fn().mockResolvedValue(makeJournalEntry({
      id: 'je-original',
      user_id: transaction.user_id,
      company_id: transaction.company_id,
      source_type: 'bank_transaction',
      source_id: transaction.id,
    })),
    attach: vi.fn().mockImplementation(({ snapshot, journalEntryId }) =>
      attachmentOutcome(snapshot, journalEntryId)),
    readback: vi.fn().mockResolvedValue(null),
    compensate: vi.fn().mockResolvedValue(null),
  }
}

const input = {
  supabase: {} as never,
  companyId: transaction.company_id,
  userId: transaction.user_id,
  transaction,
  mappingResult,
  category: 'expense_office' as const,
  isBusiness: true,
  settlementAccount: '1940',
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('settlement attachment coordinator', () => {
  it('returns the authoritative M4 readback and committed publication identity', async () => {
    const publish = vi.fn()
    const deps = Object.assign(dependencies(), { publish })
    const coordinate = createSettlementCoordinator(deps)

    const result = await coordinate(input)

    expect(result).toMatchObject({
      kind: 'attached',
      created: true,
      readback: {
        transaction: { journalEntryId: 'je-original', category: 'expense_office' },
        journalEntry: { id: 'je-original', status: 'posted' },
        cashAccount: { id: transaction.cash_account_id, ledgerAccount: '1940' },
      },
      publication: committedPublication('je-original'),
      journalEntry: { id: 'je-original' },
    })
    expect(deps.post).toHaveBeenCalledTimes(1)
    expect(deps.attach).toHaveBeenCalledTimes(1)
    expect(deps.readback).not.toHaveBeenCalled()
    expect(deps.compensate).not.toHaveBeenCalled()
    expect(publish).not.toHaveBeenCalled()
  })

  it('retries a lost M4 response exactly once with identical arguments', async () => {
    const deps = dependencies()
    vi.mocked(deps.attach)
      .mockRejectedValueOnce(new Error('response lost'))
      .mockImplementationOnce(({ snapshot, journalEntryId }) =>
        Promise.resolve(attachmentOutcome(snapshot, journalEntryId, 'pub-recovered')))
    const coordinate = createSettlementCoordinator(deps)

    const result = await coordinate(input)

    expect(result).toMatchObject({
      kind: 'attached',
      created: true,
      publication: committedPublication('je-original', 'pub-recovered'),
    })
    expect(deps.attach).toHaveBeenCalledTimes(2)
    expect(vi.mocked(deps.attach).mock.calls[0]![0]).toBe(
      vi.mocked(deps.attach).mock.calls[1]![0],
    )
    expect(deps.readback).not.toHaveBeenCalled()
    expect(deps.compensate).not.toHaveBeenCalled()
  })

  it('treats a conflicting M4 publication identity as a non-retryable partial', async () => {
    const deps = dependencies()
    vi.mocked(deps.attach).mockImplementationOnce(({ snapshot, journalEntryId }) => {
      const outcome = attachmentOutcome(snapshot, journalEntryId, 'pub-conflicting')
      outcome.publication.event_key = 'journal:je-other:committed'
      return Promise.resolve(outcome)
    })
    vi.mocked(deps.compensate).mockResolvedValueOnce(compensationOutcome())
    const coordinate = createSettlementCoordinator(deps)

    const result = await coordinate(input)

    expect(result).toEqual({
      kind: 'partial',
      code: 'SETTLEMENT_ATTACHMENT_PARTIAL',
      message: 'Konteringen kunde inte verifieras och kompenserades med en storno.',
      postedIds: {
        original_journal_entry_id: 'je-original',
        root_journal_entry_id: 'je-original',
        reversal_journal_entry_id: 'je-storno',
      },
      publicationIds: [
        'pub-conflicting',
        'pub-storno-committed',
        'pub-original-reversed',
      ],
    })
    expect(deps.attach).toHaveBeenCalledTimes(1)
    expect(deps.compensate).toHaveBeenCalledTimes(1)
  })

  it('retries a lost M5 response exactly once and retains both publication identities', async () => {
    const deps = dependencies()
    vi.mocked(deps.attach).mockResolvedValueOnce(null)
    vi.mocked(deps.compensate)
      .mockRejectedValueOnce(new Error('response lost'))
      .mockResolvedValueOnce(compensationOutcome())
    const coordinate = createSettlementCoordinator(deps)

    const result = await coordinate(input)

    expect(result).toEqual({
      kind: 'partial',
      code: 'SETTLEMENT_ATTACHMENT_PARTIAL',
      message: 'Konteringen kunde inte verifieras och kompenserades med en storno.',
      postedIds: {
        original_journal_entry_id: 'je-original',
        root_journal_entry_id: 'je-original',
        reversal_journal_entry_id: 'je-storno',
      },
      publicationIds: ['pub-storno-committed', 'pub-original-reversed'],
    })
    expect(deps.compensate).toHaveBeenCalledTimes(2)
    expect(vi.mocked(deps.compensate).mock.calls[0]![0]).toBe(
      vi.mocked(deps.compensate).mock.calls[1]![0],
    )
    expect(deps.readback).not.toHaveBeenCalled()
  })

  it('preserves every known identity from a malformed M5 envelope without retrying it', async () => {
    const deps = dependencies()
    vi.mocked(deps.attach).mockResolvedValueOnce(null)
    const malformed = compensationOutcome() as unknown as Record<string, unknown>
    malformed.publications = [
      {
        publication_id: 'pub-known-only',
        event_type: 'journal_entry.committed',
      },
    ]
    vi.mocked(deps.compensate).mockResolvedValueOnce(malformed)
    const coordinate = createSettlementCoordinator(deps)

    const result = await coordinate(input)

    expect(result).toEqual({
      kind: 'partial',
      code: 'SETTLEMENT_ATTACHMENT_PARTIAL',
      message: 'Konteringen kunde inte verifieras och kompensationsutfallet är oklart.',
      postedIds: {
        original_journal_entry_id: 'je-original',
        root_journal_entry_id: 'je-original',
        reversal_journal_entry_id: 'je-storno',
      },
      publicationIds: ['pub-known-only'],
    })
    expect(deps.compensate).toHaveBeenCalledTimes(1)
  })

  it('rejects approved snapshot drift before posting', async () => {
    const deps = dependencies()
    const coordinate = createSettlementCoordinator(deps)
    const approvedSnapshot = stageSettlementSnapshot({
      companyId: transaction.company_id,
      transaction,
      mappingResult,
      category: 'expense_office',
      isBusiness: true,
      settlementAccount: '1940',
    })
    approvedSnapshot.amountSek = 124

    const result = await coordinate({ ...input, approvedSnapshot })

    expect(result).toMatchObject({ kind: 'conflict', postedIds: {} })
    expect(deps.post).not.toHaveBeenCalled()
    expect(deps.attach).not.toHaveBeenCalled()
  })

  it('accepts an existing entry only as an exact no-op', async () => {
    const existingTransaction = { ...transaction, journal_entry_id: 'je-existing' } as Transaction
    const deps = dependencies()
    vi.mocked(deps.readback).mockImplementationOnce(({ snapshot, journalEntryId }) =>
      Promise.resolve(exactReadback(snapshot, journalEntryId)))
    const coordinate = createSettlementCoordinator(deps)

    const result = await coordinate({ ...input, transaction: existingTransaction })

    expect(result).toMatchObject({ kind: 'attached', created: false })
    expect(deps.post).not.toHaveBeenCalled()
    expect(deps.attach).not.toHaveBeenCalled()
  })

  it('rejects a mismatched existing entry without posting or mutating it', async () => {
    const existingTransaction = { ...transaction, journal_entry_id: 'je-existing' } as Transaction
    const deps = dependencies()
    vi.mocked(deps.readback).mockImplementationOnce(({ snapshot, journalEntryId }) => {
      const mismatched = exactReadback(snapshot, journalEntryId)
      mismatched.journalEntry.category = 'expense_travel'
      return Promise.resolve(mismatched)
    })
    const coordinate = createSettlementCoordinator(deps)

    const result = await coordinate({ ...input, transaction: existingTransaction })

    expect(result).toMatchObject({ kind: 'conflict', postedIds: {} })
    expect(deps.post).not.toHaveBeenCalled()
    expect(deps.attach).not.toHaveBeenCalled()
    expect(deps.compensate).not.toHaveBeenCalled()
  })

  it('never synthesizes success when another attachment identity wins', async () => {
    const deps = dependencies()
    vi.mocked(deps.attach).mockImplementationOnce(({ snapshot, journalEntryId }) => {
      const outcome = attachmentOutcome(snapshot, journalEntryId, 'pub-other-winner')
      outcome.journal_entry_id = 'je-other-winner'
      outcome.readback.transaction.journalEntryId = 'je-other-winner'
      outcome.readback.journalEntry.id = 'je-other-winner'
      return Promise.resolve(outcome)
    })
    vi.mocked(deps.compensate).mockResolvedValueOnce(compensationOutcome())
    const coordinate = createSettlementCoordinator(deps)

    const result = await coordinate(input)

    expect(result).toMatchObject({
      kind: 'partial',
      postedIds: {
        original_journal_entry_id: 'je-original',
        returned_journal_entry_id: 'je-other-winner',
        readback_journal_entry_id: 'je-other-winner',
        reversal_journal_entry_id: 'je-storno',
      },
      publicationIds: [
        'pub-other-winner',
        'pub-storno-committed',
        'pub-original-reversed',
      ],
    })
    expect(deps.attach).toHaveBeenCalledTimes(1)
  })
})
