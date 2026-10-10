/**
 * Model route resolution against `ctx.llm`, mirroring Remote-Task's `model.ts`.
 *
 * When the task supplies a `model` field, that exact model is resolved
 * (searching across registered providers when no `provider` is given).
 * When neither is supplied, the first available model from the registered
 * provider routes is auto-discovered via `ctx.llm.listProviders()` and
 * `ctx.llm.listModels()`.
 *
 * @module dsh-redis-queue-custom-plugin/model
 */

import type { Context } from '@deepseek-ai/cordis'
import { ReasoningEffortId, errorChain, type LlmCallConfig } from '@deepseek-ai/dsh-llm'
import { debugLog } from './debug.ts'

/** Optional per-task model override; absent falls back to auto-discovery. */
export interface ModelRequest {
  readonly provider?: string
  readonly model?: string
  readonly reasoningEffort?: string
  readonly maxTokens?: number
}

/** A resolved, validated model route plus per-session generation limits. */
export interface ResolvedModel {
  readonly provider: string
  readonly model: string
  readonly reasoningEffort?: unknown
  readonly maxTokens?: number
}

/**
 * Resolve and validate a model route.
 *
 * Resolution order:
 * 1. Task specifies both `provider` and `model` → validate that exact route.
 * 2. Task specifies `model` only → search registered providers for one that
 *    accepts this model id.
 * 3. Task specifies nothing → use the configured defaults (defaultProvider/
 *    defaultModel). If defaults fail, fall back to auto-discovery.
 *
 * @param ctx - plugin context with the llm service.
 * @param req - optional per-task model override.
 * @param defaultProvider - deployment default provider (used when req has no provider).
 * @param defaultModel - deployment default model (used when req has no model).
 * @returns the resolved model route.
 * @throws {Error} when no valid model route can be resolved.
 */
export async function resolveModelSelection(
  ctx: Context,
  req: ModelRequest | undefined,
  defaultProvider: string,
  defaultModel: string,
): Promise<ResolvedModel> {
  // Case 1: explicit provider + model from the task.
  if (req?.provider && req?.model) {
    return resolveExactRoute(ctx, req.provider, req.model, req)
  }

  // Case 2: explicit model only → search across providers.
  if (req?.model) {
    return resolveModelAcrossProviders(ctx, req.model, req)
  }

  // Case 3: no model specified → use configured defaults first.
  try {
    return await resolveExactRoute(ctx, defaultProvider, defaultModel, req)
  } catch {
    // Defaults failed → fall back to auto-discovery.
    debugLog(`[redis-queue] defaults ${defaultProvider}/${defaultModel} failed, trying auto-discovery`)
    return autoDiscoverModel(ctx, req)
  }
}

/**
 * Validate an explicit provider/model pair via `resolveCallConfig`.
 */
async function resolveExactRoute(
  ctx: Context,
  provider: string,
  model: string,
  req: ModelRequest | undefined,
): Promise<ResolvedModel> {
  const draft: LlmCallConfig = {
    provider,
    model,
    ...(req?.reasoningEffort !== undefined ? { reasoningEffort: ReasoningEffortId(req.reasoningEffort) } : {}),
    ...(req?.maxTokens !== undefined ? { maxTokens: req.maxTokens } : {}),
  }
  try {
    const resolved = await ctx.llm.resolveCallConfig(draft) as LlmCallConfig
    return {
      provider: String(resolved.provider ?? provider),
      model: String(resolved.model ?? model),
      ...(resolved.reasoningEffort !== undefined ? { reasoningEffort: resolved.reasoningEffort } : {}),
      ...(resolved.maxTokens !== undefined ? { maxTokens: resolved.maxTokens } : {}),
    }
  } catch (error: unknown) {
    ctx.logger.warn(`[redis-queue] invalid model route ${provider}/${model}: ${errorChain(error)}`)
    throw new Error(`invalid model route: ${provider}/${model}`)
  }
}

/**
 * Search registered providers for one that accepts the given model id.
 * Tries each provider returned by `listProviders()` until `resolveCallConfig`
 * succeeds for at least one.
 */
async function resolveModelAcrossProviders(
  ctx: Context,
  model: string,
  req: ModelRequest | undefined,
): Promise<ResolvedModel> {
  const providers = listRegisteredProviders(ctx)
  if (providers.length === 0) {
    throw new Error('no provider routes registered; cannot resolve model')
  }
  const errors: string[] = []
  for (const providerId of providers) {
    try {
      return await resolveExactRoute(ctx, providerId, model, req)
    } catch (error: unknown) {
      errors.push(`${providerId}: ${errorChain(error)}`)
    }
  }
  const summary = errors.join('; ')
  ctx.logger.warn(`[redis-queue] model "${model}" not found in any provider: ${summary}`)
  throw new Error(`model "${model}" not found in any registered provider`)
}

/**
 * Auto-discover the first available model from registered providers.
 * Iterates `listProviders()` → `listModels(provider)` and validates the first
 * candidate via `resolveCallConfig`. Used as a fallback when the configured
 * defaults fail.
 */
async function autoDiscoverModel(
  ctx: Context,
  req: ModelRequest | undefined,
): Promise<ResolvedModel> {
  const providers = listRegisteredProviders(ctx)
  for (const providerId of providers) {
    try {
      const models = await listProviderModels(ctx, providerId)
      if (models.length === 0) continue
      // Pick the first model advertised by this provider.
      const candidate = models[0] as string
      debugLog(`[redis-queue] auto-discovered model: ${providerId}/${candidate}`)
      return await resolveExactRoute(ctx, providerId, candidate, req)
    } catch {
      // Provider has no models or resolveCallConfig failed; try next.
    }
  }
  throw new Error('auto-discovery found no usable model from any registered provider')
}

/**
 * List registered provider route ids via `ctx.llm.listProviders()`.
 * Returns an empty array when the method is unavailable (e.g. test stubs).
 */
function listRegisteredProviders(ctx: Context): string[] {
  try {
    const providers = ctx.llm.listProviders() as Array<{ id: string }>
    return providers.map(p => p.id)
  } catch {
    return []
  }
}

/**
 * List model ids advertised by one provider via `ctx.llm.listModels()`.
 * Returns an empty array when the method is unavailable.
 */
async function listProviderModels(ctx: Context, providerId: string): Promise<string[]> {
  try {
    const models = await ctx.llm.listModels(providerId) as Array<{ id: string }>
    return models.map(m => m.id)
  } catch {
    return []
  }
}

/** Project a resolved model into the `agentOptions` shape `ctx.agents.create` expects. */
export function agentOptionsOf(resolved: ResolvedModel): Record<string, unknown> {
  return {
    provider: resolved.provider,
    model: resolved.model,
    ...(resolved.reasoningEffort !== undefined ? { reasoningEffort: resolved.reasoningEffort } : {}),
    ...(resolved.maxTokens !== undefined ? { maxTokens: resolved.maxTokens } : {}),
  }
}
