import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  notifyDurableWebhookDeliveries,
  registerDurableDispatchKick,
  resetDurableDispatchKickForTests,
} from '../durable-dispatch-notify'

beforeEach(() => resetDurableDispatchKickForTests())

describe('durable webhook dispatch notification', () => {
  it('is a safe no-op before server webhook initialization', () => {
    expect(() => notifyDurableWebhookDeliveries()).not.toThrow()
  })

  it('invokes the server-registered non-blocking dispatch kick', () => {
    const kick = vi.fn()
    registerDurableDispatchKick(kick)

    notifyDurableWebhookDeliveries()

    expect(kick).toHaveBeenCalledTimes(1)
  })
})