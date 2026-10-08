/**
 * Session launcher: create an agent for a task, inject its resolved skills, bind
 * it to the workspace, and deliver the first prompt. Replicates Remote-Task's
 * minimal create path (`composeCreate` + `prompt`) against the host primitives.
 *
 * @module dsh-redis-queue-custom-plugin/launcher
 */

import { randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import { brandString } from '@deepseek-ai/dsh-brand'
import { createUserMessage, errorChain } from '@deepseek-ai/dsh-llm'
import type { Agent, AgentHandle } from '@deepseek-ai/dsh-agent'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type { WorkspaceRegistry } from '@deepseek-ai/dsh-workspace'
import type { QueueConfig } from './config.ts'
import type { LaunchInput } from './types.ts'
import { agentOptionsOf, resolveModelSelection } from './model.ts'
import { injectSkills } from './skills.ts'
import { buildPrompt } from './prompt.ts'

export class SessionLauncher {
  constructor(
    private readonly ctx: Context,
    private readonly cfg: QueueConfig,
  ) {}

  /**
   * Create a session for the task and deliver its first prompt.
   *
   * @param input - the task, its resolved workspace, and resolved skill ids.
   * @returns the new session id (tracked by the caller for completion).
   * @throws {Error} when model resolution or agent composition fails; the caller
   *   classifies it as recoverable (requeue) or permanent (DLQ).
   */
  async launch(input: LaunchInput): Promise<string> {
    const { task, workspace, skillIds } = input
    const sessionId = brandString<SessionId>(randomUUID())
    const resolved = await resolveModelSelection(
      this.ctx,
      undefined,
      this.cfg.defaultProvider,
      this.cfg.defaultModel,
    )
    const prompt = buildPrompt(task, this.cfg.promptTemplate)

    const handle: AgentHandle = await this.ctx.agents.create({
      sessionId,
      meta: { cwd: workspace.path },
      agentOptions: agentOptionsOf(resolved),
      setup: async (agentCtx: Context, agent: Agent) => {
        await injectSkills(this.ctx, agentCtx, agent, skillIds, workspace.path)
      },
    })

    // Account the session to its workspace so the host groups it (not ungrouped).
    await this.attachToWorkspace(workspace.id, sessionId)

    // Deliver the first prompt. `followup` may be sync (message queued) or
    // return a promise; both shapes are handled so a rejection never becomes
    // an unhandled rejection. A sync throw disposes the freshly-created agent
    // and rethrows so `consumeOne` runs the requeue / DLQ path.
    const message = createUserMessage({ content: [{ type: 'text', text: prompt }], source: { kind: 'user' } })
    try {
      const result = handle.agent.followup(message) as unknown
      if (isThenable(result)) {
        result.catch((error: unknown) => {
          this.ctx.logger.warn(
            '[redis-queue] followup rejected sessionId=%s: %s',
            String(sessionId),
            errorChain(error),
          )
          void this.safeDispose(handle, sessionId)
        })
      }
    } catch (error: unknown) {
      await this.safeDispose(handle, sessionId)
      throw error
    }

    this.ctx.logger.info(
      '[redis-queue] session launched id=%s project=%s user=%s skills=%d',
      String(sessionId),
      task.projectId,
      task.userCode,
      skillIds.length,
    )
    return String(sessionId)
  }

  /** Dispose a handle, swallowing (and logging) any error so callers stay linear. */
  private async safeDispose(handle: AgentHandle, sessionId: SessionId): Promise<void> {
    try {
      await handle.dispose()
    } catch (error: unknown) {
      this.ctx.logger.warn(
        '[redis-queue] dispose after failed launch errored sessionId=%s: %s',
        String(sessionId),
        errorChain(error),
      )
    }
  }

  /** Attach a freshly composed session to its workspace; non-fatal on failure. */
  private async attachToWorkspace(workspaceId: string, sessionId: SessionId): Promise<void> {
    try {
      const registry = this.ctx.workspaceRegistry as WorkspaceRegistry
      await registry.get(workspaceId)?.attachSession(sessionId)
    } catch (error: unknown) {
      this.ctx.logger.warn('[redis-queue] attachSession failed for %s: %s', workspaceId, String(error))
    }
  }
}

/** Narrow an unknown `followup` return to a promise when it is thenable. */
function isThenable(value: unknown): value is Promise<unknown> {
  return (
    value !== null &&
    (typeof value === 'object' || typeof value === 'function') &&
    typeof (value as { catch?: unknown }).catch === 'function'
  )
}
