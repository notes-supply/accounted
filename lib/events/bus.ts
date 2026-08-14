import type { CoreEvent, CoreEventType, EventHandler } from './types'
import { createLogger } from '@/lib/logger'

// Internal handler type: loose enough for the Map, but type-safe at the public API
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyHandler = (payload: any) => Promise<void> | void

const log = createLogger('event-bus')

/**
 * In-process event bus.
 *
 * - Handlers run concurrently via Promise.allSettled (failing handler never crashes emitter)
 * - Module-level singleton (persists across requests in same process)
 * - One-way: core services emit, extensions subscribe
 * - Rejected handlers are logged with structured fields so they're greppable
 *   in Vercel logs by event type, handler name, and the originating request id
 *   (when carried in the payload).
 */
class EventBus {
  private extensionHandlers = new Map<string, Set<AnyHandler>>()
  private coreHandlers = new Map<string, Set<AnyHandler>>()

  on<T extends CoreEventType>(
    eventType: T,
    handler: EventHandler<T>
  ): () => void {
    return this.subscribe(this.extensionHandlers, eventType, handler)
  }

  /** Register a built-in persistence or delivery handler. */
  onCore<T extends CoreEventType>(
    eventType: T,
    handler: EventHandler<T>
  ): () => void {
    return this.subscribe(this.coreHandlers, eventType, handler)
  }

  private subscribe<T extends CoreEventType>(
    handlers: Map<string, Set<AnyHandler>>,
    eventType: T,
    handler: EventHandler<T>,
  ): () => void {
    if (!handlers.has(eventType)) handlers.set(eventType, new Set())
    const handlerSet = handlers.get(eventType)!
    handlerSet.add(handler as AnyHandler)

    return () => {
      handlerSet.delete(handler as AnyHandler)
      if (handlerSet.size === 0) handlers.delete(eventType)
    }
  }

  async emit(event: CoreEvent): Promise<void> {
    await this.emitTo(event, [this.coreHandlers, this.extensionHandlers])
  }

  /**
   * Dispatch only extension subscribers when core persistence was completed by
   * an atomic database command. This avoids duplicating event_log and webhook
   * rows while preserving the in-process extension contract.
   */
  async emitExtensions(event: CoreEvent): Promise<void> {
    await this.emitTo(event, [this.extensionHandlers])
  }

  private async emitTo(
    event: CoreEvent,
    sources: Array<Map<string, Set<AnyHandler>>>,
  ): Promise<void> {
    const handlers = sources.flatMap(
      (source) => [...(source.get(event.type) ?? [])],
    )
    if (handlers.length === 0) return

    const results = await Promise.allSettled(
      handlers.map((handler) => handler(event.payload))
    )

    for (let i = 0; i < results.length; i++) {
      const result = results[i]
      if (result.status === 'rejected') {
        const handler = handlers[i]
        const handlerName = handler.name || 'anonymous'
        const payload = event.payload as Record<string, unknown>

        log.error('handler failed', result.reason, {
          eventType: event.type,
          handler: handlerName,
          companyId: typeof payload.companyId === 'string' ? payload.companyId : undefined,
          userId: typeof payload.userId === 'string' ? payload.userId : undefined,
        })
      }
    }
  }

  /** Remove all handlers (useful for testing). */
  clear(): void {
    this.extensionHandlers.clear()
    this.coreHandlers.clear()
  }
}

/** Module-level singleton */
export const eventBus = new EventBus()
