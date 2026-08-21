import Anthropic from '@anthropic-ai/sdk'
import AnthropicBedrock from '@anthropic-ai/bedrock-sdk'

/**
 * Which backend AI traffic goes to.
 *
 * Hosted runs on AWS Bedrock: keeping inference inside eu-north-1 is a
 * deliberate BFL/GDPR posture for Swedish accounting data, not an
 * implementation detail. Self-hosted deployments generally have no AWS
 * account at all, so they get the direct Anthropic API with a plain
 * ANTHROPIC_API_KEY, or any OpenAI-compatible endpoint (the Swedish inference
 * providers a sovereign self-host points at, or a local model) via
 * AI_BASE_URL (+ AI_API_KEY when the endpoint requires auth).
 *
 * The two Anthropic-family backends share the `messages.create/stream`
 * surface this factory hands out. The OpenAI-compatible backend does not: it
 * is reachable only through the job-shaped service in lib/ai (getAiService),
 * and createAiClient() refuses it loudly rather than returning a client that
 * would fail at call time.
 *
 * See https://github.com/erp-mafia/accounted/issues/1406.
 */
export type AiProvider = 'bedrock' | 'anthropic' | 'openai-compatible'

/**
 * Thrown by createAiClient() when the resolved backend has no Anthropic
 * messages surface. Surfaces that still call the SDK directly (the chat loop,
 * composer, receipt hunt, WhatsApp interpreter) are unavailable on such a
 * backend until they move onto getAiService(); routes check
 * getAiStatus().assistantAvailable first so users get a 503 instead of this.
 */
export class AiProviderUnsupportedError extends Error {
  readonly provider: AiProvider
  constructor(provider: AiProvider) {
    super(
      `AI provider "${provider}" has no Anthropic messages surface; use getAiService() from @/lib/ai instead of createAiClient()`
    )
    this.name = 'AiProviderUnsupportedError'
    this.provider = provider
  }
}

export type AiClient = Anthropic | AnthropicBedrock

/**
 * Resolve the provider from the environment, or null when neither backend has
 * usable credentials.
 *
 * Precedence is deliberate:
 *
 *   1. `AI_PROVIDER` wins when set. The escape hatch for a deployment that has
 *      several credential sets and needs to say which one it means.
 *   2. A Bedrock bearer token means Bedrock. Within Bedrock it takes precedence
 *      over static keys and the AWS credential provider chain.
 *   3. Static AWS keys mean Bedrock. This keeps hosted inference in eu-north-1
 *      if an operator adds an Anthropic key for a side experiment.
 *   4. Otherwise an Anthropic key means the direct API. This is the
 *      self-hosted path.
 *   4b. Otherwise an OpenAI-compatible base URL means that endpoint.
 *      This is the sovereign self-hosted path (BYO Swedish provider).
 *   5. Otherwise Bedrock without explicit credentials, so the AWS credential
 *      provider chain (instance profile, IRSA, EKS pod identity) still gets a
 *      chance. `hasAiCredentials()` reports false here because the chain is
 *      not visible from this process.
 */
export function resolveAiProvider(): AiProvider {
  const explicit = (process.env.AI_PROVIDER ?? '').trim().toLowerCase()
  if (explicit === 'bedrock' || explicit === 'anthropic' || explicit === 'openai-compatible') {
    return explicit
  }


  if (process.env.AWS_BEARER_TOKEN_BEDROCK) return 'bedrock'
  if (process.env.AWS_ACCESS_KEY_ID && process.env.AWS_SECRET_ACCESS_KEY) return 'bedrock'
  if (process.env.ANTHROPIC_API_KEY) return 'anthropic'
  if (process.env.AI_BASE_URL) return 'openai-compatible'
  return 'bedrock'
}

/**
 * Whether this deployment has credentials we can see from the environment.
 *
 * Used by call sites that must degrade quietly rather than throw: document
 * extraction returns an empty result instead of failing an upload. Returns
 * false for the AWS provider chain (case 4 above) because it is not visible
 * here; that path was already treated the same way before the direct-API
 * option existed.
 */
export function hasAiCredentials(): boolean {
  const provider = resolveAiProvider()
  if (provider === 'anthropic') return !!process.env.ANTHROPIC_API_KEY
  // AI_API_KEY is optional: a local OpenAI-compatible server (llama.cpp,
  // Ollama, LM Studio, vLLM) usually has no auth, so a base URL alone counts
  // as configured. When a hosted Swedish provider needs a key, the operator
  // sets AI_API_KEY and the service sends it as a Bearer token.
  if (provider === 'openai-compatible') return !!process.env.AI_BASE_URL
  return !!process.env.AWS_BEARER_TOKEN_BEDROCK ||
    !!(process.env.AWS_ACCESS_KEY_ID && process.env.AWS_SECRET_ACCESS_KEY)
}

/**
 * Build a client for the resolved Anthropic-family provider. Both expose the
 * same `messages.create` / `messages.stream` surface, which is all the direct
 * SDK callers in this codebase use. Throws AiProviderUnsupportedError for the
 * OpenAI-compatible backend: see the class doc. New code should not call this
 * at all; go through getAiService() from @/lib/ai (antipattern guard
 * direct-ai-client enforces that outside lib/ai/services).
 */
export function createAiClient(): AiClient {
  const provider = resolveAiProvider()
  if (provider === 'openai-compatible') throw new AiProviderUnsupportedError(provider)
  if (provider === 'anthropic') {
    const apiKey = process.env.ANTHROPIC_API_KEY
    // Omit the key when unset so the SDK resolves it itself and fails at call
    // time: throwing here would take down every route that merely imports a
    // module touching AI.
    return apiKey ? new Anthropic({ apiKey }) : new Anthropic()
  }

  const awsRegion = process.env.AWS_REGION || 'eu-north-1'
  const bearerToken = process.env.AWS_BEARER_TOKEN_BEDROCK
  if (bearerToken) {
    return new AnthropicBedrock({ apiKey: bearerToken, awsRegion })
  }
  const awsAccessKey = process.env.AWS_ACCESS_KEY_ID
  const awsSecretKey = process.env.AWS_SECRET_ACCESS_KEY
  // When both static keys are present, pass them. Otherwise omit them so the
  // SDK falls back to the AWS credential provider chain. The two-overload SDK
  // refuses a mix.
  return awsAccessKey && awsSecretKey
    ? new AnthropicBedrock({ awsRegion, awsAccessKey, awsSecretKey })
    : new AnthropicBedrock({ awsRegion })
}

/**
 * Map a bare Anthropic model id to the form the resolved provider expects.
 *
 * Bedrock needs the `eu.` inference-profile prefix: a bare
 * `anthropic.claude-sonnet-5` is rejected because on-demand throughput
 * requires the cross-region profile. The direct API takes the bare id and
 * rejects both prefixes.
 *
 * Ids that already carry a provider prefix pass through untouched, so an
 * operator-supplied override in either form keeps working.
 */
export function toProviderModelId(bareModelId: string, provider = resolveAiProvider()): string {
  if (provider === 'anthropic' || provider === 'openai-compatible') return bareModelId
  if (bareModelId.startsWith('eu.') || bareModelId.startsWith('anthropic.')) return bareModelId
  return `eu.anthropic.${bareModelId}`
}

/**
 * Non-secret identification of the configured credential, for startup logs.
 * Anthropic keys carry a public prefix (`sk-ant-api03` for a standard API key,
 * `sk-ant-oat` for an OAuth token); AWS access key ids carry `AKIA` for a
 * long-term IAM user key and `ASIA` for an STS/role credential. Bedrock bearer
 * tokens have no public portion, so they are identified only as `bearer`.
 * Never returns any part of a secret.
 */
export function aiCredentialPrefix(): string | null {
  const provider = resolveAiProvider()
  if (provider === 'anthropic') {
    return process.env.ANTHROPIC_API_KEY?.slice(0, 12) ?? null
  }
  // OpenAI-compatible keys have no standard public prefix, so there is no
  // non-secret slice to log: identify the endpoint instead.
  if (provider === 'openai-compatible') return null
  if (process.env.AWS_BEARER_TOKEN_BEDROCK) return 'bearer'
  return process.env.AWS_ACCESS_KEY_ID?.slice(0, 4) ?? null
}
