/**
 * Model route resolution against `ctx.llm`, mirroring Remote-Task's `model.ts`.
 *
 * @module dsh-redis-queue-custom-plugin/model
 */

import type { Context } from '@deepseek-ai/cordis'
import { ReasoningEffortId, errorChain, type LlmCallConfig } from '@deepseek-ai/dsh-llm'

/** Optional per-task model override; absent falls back to deployment defaults. */
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
 * Resolve and validate a model route from an optional override or the
 * deployment defaults, using `ctx.llm.resolveCallConfig` to verify the
 * provider/model pair is registered and to carry generation limits through.
 *
 * @param ctx - plugin context with the llm service.
 * @param req - optional per-task model override.
 * @param defaultProvider - deployment default provider.
 * @param defaultModel - deployment default model.
 * @returns the resolved model route.
 * @throws {Error} when the provider/model pair is not registered.
 */
export async function resolveModelSelection(
  ctx: Context,
  req: ModelRequest | undefined,
  defaultProvider: string,
  defaultModel: string,
): Promise<ResolvedModel> {
  const provider = req?.provider ?? defaultProvider
  const model = req?.model ?? defaultModel

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

/** Project a resolved model into the `agentOptions` shape `ctx.agents.create` expects. */
export function agentOptionsOf(resolved: ResolvedModel): Record<string, unknown> {
  return {
    provider: resolved.provider,
    model: resolved.model,
    ...(resolved.reasoningEffort !== undefined ? { reasoningEffort: resolved.reasoningEffort } : {}),
    ...(resolved.maxTokens !== undefined ? { maxTokens: resolved.maxTokens } : {}),
  }
}
