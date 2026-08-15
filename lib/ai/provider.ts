import Anthropic from '@anthropic-ai/sdk'
import AnthropicBedrock from '@anthropic-ai/bedrock-sdk'

/**
 * Which backend Claude traffic goes to.
 *
 * Hosted runs on AWS Bedrock: keeping inference inside eu-north-1 is a
 * deliberate BFL/GDPR posture for Swedish accounting data, not an
 * implementation detail. Self-hosted deployments generally have no AWS
 * account at all, so they get the direct Anthropic API with a plain
 * ANTHROPIC_API_KEY.
 *
 * See https://github.com/erp-mafia/accounted/issues/1406.
 */
export type AiProvider = 'bedrock' | 'anthropic'

export type AiClient = Anthropic | AnthropicBedrock

/**
 * Resolve the provider from the environment. Bedrock is the default so the AWS
 * credential provider chain gets a chance when no environment key is visible.
 *
 * Precedence is deliberate:
 *
 *   1. `AI_PROVIDER` wins when set. The escape hatch for a deployment that has
 *      both credential sets and needs to say which one it means.
 *   2. A Bedrock bearer token means Bedrock. Within Bedrock it takes precedence
 *      over static keys and the AWS credential provider chain.
 *   3. Static AWS keys mean Bedrock. This is what keeps hosted byte-identical:
 *      an operator who adds an Anthropic key for a side experiment must not
 *      silently move production inference out of eu-north-1.
 *   4. Otherwise an Anthropic key means the direct API. This is the
 *      self-hosted path.
 *   5. Otherwise Bedrock without explicit credentials, so the AWS credential
 *      provider chain (instance profile, IRSA, EKS pod identity) still resolves
 *      on hosted infrastructure that injects credentials rather than setting
 *      env vars. `hasAiCredentials()` reports false here: we cannot see the
 *      chain from this side, so callers that need a cheap pre-flight treat it
 *      as unconfigured rather than paying a request to find out.
 */
export function resolveAiProvider(): AiProvider {
  const explicit = (process.env.AI_PROVIDER ?? '').trim().toLowerCase()
  if (explicit === 'bedrock' || explicit === 'anthropic') return explicit

  if (process.env.AWS_BEARER_TOKEN_BEDROCK) return 'bedrock'

  if (process.env.AWS_ACCESS_KEY_ID && process.env.AWS_SECRET_ACCESS_KEY) return 'bedrock'
  if (process.env.ANTHROPIC_API_KEY) return 'anthropic'
  return 'bedrock'
}

/**
 * Whether this deployment has credentials we can see from the environment.
 *
 * Used by call sites that must degrade quietly rather than throw: document
 * extraction returns an empty result instead of failing an upload. Returns
 * false for the AWS provider chain (case 5 above) because it is not visible
 * here; that path was already treated the same way before the direct-API
 * option existed.
 */
export function hasAiCredentials(): boolean {
  return resolveAiProvider() === 'anthropic'
    ? !!process.env.ANTHROPIC_API_KEY
    : !!process.env.AWS_BEARER_TOKEN_BEDROCK ||
        !!(process.env.AWS_ACCESS_KEY_ID && process.env.AWS_SECRET_ACCESS_KEY)
}

/**
 * Build a client for the resolved provider. Both expose the same
 * `messages.create` / `messages.stream` surface, which is all this codebase
 * uses of either SDK.
 */
export function createAiClient(): AiClient {
  if (resolveAiProvider() === 'anthropic') {
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
  if (provider === 'anthropic') return bareModelId
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
  if (resolveAiProvider() === 'anthropic') {
    return process.env.ANTHROPIC_API_KEY?.slice(0, 12) ?? null
  }
  if (process.env.AWS_BEARER_TOKEN_BEDROCK) return 'bearer'
  return process.env.AWS_ACCESS_KEY_ID?.slice(0, 4) ?? null
}
