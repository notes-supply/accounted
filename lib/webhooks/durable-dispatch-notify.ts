/**
 * Client-safe seam between isomorphic bookkeeping code and server-only webhook
 * dispatch. The webhook handler registers the real kick during server init.
 * Scripts or uninitialised contexts safely fall back to the cron sweep.
 */

type DurableDispatchKick = () => void

let registeredKick: DurableDispatchKick | null = null

export function registerDurableDispatchKick(kick: DurableDispatchKick): void {
  registeredKick = kick
}

export function notifyDurableWebhookDeliveries(): void {
  registeredKick?.()
}

export function resetDurableDispatchKickForTests(): void {
  registeredKick = null
}