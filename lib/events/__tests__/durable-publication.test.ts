import { beforeEach, describe, expect, it, vi } from 'vitest'
import { eventBus } from '@/lib/events/bus'
import {
  hasDurablePublicationMarker,
  type DurablePublicationPayload,
} from '@/lib/events/types'
import { makeJournalEntry } from '@/tests/helpers'

const { createServiceClientNoCookies } = vi.hoisted(() => ({
  createServiceClientNoCookies: vi.fn(),
}))
vi.mock('@/lib/auth/api-keys', () => ({
  createServiceClientNoCookies,
}))

vi.mock('@/lib/logger', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}))

import { registerEventLogHandler } from '../handlers/event-log-handler'
import { registerWebhookHandler } from '@/lib/webhooks/handler'

describe('durable publication projection marker', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    eventBus.clear()
  })

  it('recognizes only a complete durable-publication identity', () => {
    expect(hasDurablePublicationMarker({
      durablePublication: {
        persisted: true,
        publication_id: 'publication-1',
        event_key: 'journal:entry-1:committed',
      },
    })).toBe(true)
    expect(hasDurablePublicationMarker({
      durablePublication: {
        persisted: true,
        publication_id: 'publication-1',
        event_key: '',
      },
    })).toBe(false)
    expect(hasDurablePublicationMarker({ durablePublication: true })).toBe(false)
  })

  it('skips both core projections while preserving best-effort extension dispatch', async () => {
    const marker: DurablePublicationPayload = {
      durablePublication: {
        persisted: true,
        publication_id: 'publication-1',
        event_key: 'journal:entry-1:committed',
      },
    }
    const payload = {
      entry: makeJournalEntry({ id: 'entry-1', company_id: 'co-1' }),
      userId: 'user-1',
      companyId: 'co-1',
      ...marker,
    }
    const extensionHandler = vi.fn().mockRejectedValue(
      new Error('extension execution remains best effort'),
    )

    registerEventLogHandler()
    registerWebhookHandler()
    eventBus.on('journal_entry.committed', extensionHandler)
    await expect(eventBus.emit({
      type: 'journal_entry.committed',
      payload,
    })).resolves.toBeUndefined()

    expect(createServiceClientNoCookies).not.toHaveBeenCalled()
    expect(extensionHandler).toHaveBeenCalledWith(payload)
  })
})
