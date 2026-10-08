/**
 * Task consumer: the single orchestrator that turns one dequeued payload into a
 * launched session — dequeue → backup → validate → idempotency claim → workspace
 * (locked) → skill resolution → session launch → track — with recovery on
 * failure (requeue or dead-letter).
 *
 * @module dsh-redis-queue-custom-plugin/consumer
 */

import type { Context } from '@deepseek-ai/cordis'
import { errorChain } from '@deepseek-ai/dsh-llm'
import type { QueueConfig } from './config.ts'
import type { IdempotencyGuard } from './idempotency.ts'
import type { QueueStore } from './queue.ts'
import type { SkillResolver } from './skills.ts'
import type { WorkspaceProvisioner } from './workspace.ts'
import type { SessionLauncher } from './launcher.ts'
import type { ActiveSessionTracker } from './tracker.ts'
import type { TaskPayload, ValidateResult } from './types.ts'

/** Collaborators injected into the consumer (all independently testable). */
export interface ConsumerDeps {
  readonly queue: QueueStore
  readonly idem: IdempotencyGuard
  readonly workspaces: WorkspaceProvisioner
  readonly skills: SkillResolver
  readonly launcher: SessionLauncher
  readonly tracker: ActiveSessionTracker
}

export class TaskConsumer {
  constructor(
    private readonly ctx: Context,
    private readonly cfg: QueueConfig,
    private readonly deps: ConsumerDeps,
  ) {}

  /**
   * Consume at most one task.
   * @returns true when a task was dequeued and handled (launched, skipped as a
   *   duplicate, requeued, or dead-lettered); false when the queue was empty.
   */
  async consumeOne(): Promise<boolean> {
    const raw = await this.deps.queue.pop()
    if (raw === null) return false

    // Back up before touching it, so a crash mid-handling leaves a recovery trace.
    // The backup entry is keyed by the exact raw bytes we just popped, so every
    // ack must pass the SAME `raw` reference (never the normalized `task`, whose
    // key order and defaults differ and would leave the entry stuck in Redis).
    await this.deps.queue.backup(raw)

    const result = validateTask(raw)
    if (!result.ok) {
      await this.deps.queue.toDlq(asTask(raw), result.reason)
      await this.deps.queue.ackBackup(raw)
      return true
    }
    const task = result.task

    try {
      // Idempotency: a duplicate requestId means it is already running or done.
      const claim = await this.deps.idem.claim(task.requestId)
      if (claim.state === 'duplicate') {
        this.ctx.logger.info('[redis-queue] duplicate requestId=%s (%s), skip', task.requestId, claim.status)
        await this.deps.queue.ackBackup(raw)
        return true
      }

      const workspace = await this.deps.workspaces.ensure(task.projectId, task.taskName)
      const skillIds = await this.deps.skills.resolve(task.skillIds)
      const sessionId = await this.deps.launcher.launch({ task, workspace, skillIds })
      this.deps.tracker.track(sessionId, { requestId: task.requestId, backup: raw, task })
      return true
    } catch (error: unknown) {
      await this.handleFailure(raw, task, error)
      return true
    }
  }

  /**
   * Recover from a handling failure: release the idempotency claim and either
   * requeue (recoverable, under the retry cap) or dead-letter (permanent /
   * exhausted). The processing backup is always acked since the task leaves the
   * in-flight state either way.
   *
   * `raw` is the exact object that was pushed onto the processing backup list —
   * it MUST be the value passed to `ackBackup` so `lRem` matches byte-for-byte
   * under the redis plugin's `value: json` codec. `task` is the normalized form
   * used for the requeue payload (canonical field order, defaults applied).
   */
  private async handleFailure(raw: TaskPayload, task: TaskPayload, error: unknown): Promise<void> {
    const reason = errorChain(error)
    const retries = task.__retries ?? 0
    await this.deps.idem.release(task.requestId)
    await this.deps.queue.ackBackup(raw)

    if (this.cfg.requeueOnFailure && retries < this.cfg.maxRetries) {
      await this.deps.queue.requeue(task, retries + 1)
      this.ctx.logger.warn(
        '[redis-queue] handling failed, requeued requestId=%s retry=%d: %s',
        task.requestId,
        retries + 1,
        reason,
      )
      return
    }
    await this.deps.queue.toDlq(task, `handling failed after ${retries} retries: ${reason}`)
  }
}

/**
 * Validate a dequeued payload against the task schema. `projectId` and
 * `requestId` are mandatory; the remaining fields fall back to safe defaults so
 * a slightly-underfilled producer payload still processes (with the defaults
 * visible in the prompt).
 * @param raw - the decoded queue element.
 * @returns the normalized task, or a reason when it is a poison message.
 */
export function validateTask(raw: unknown): ValidateResult {
  if (typeof raw !== 'object' || raw === null) {
    return { ok: false, reason: 'payload is not an object' }
  }
  const obj = raw as Record<string, unknown>

  const projectId = str(obj.projectId)
  if (projectId === undefined || projectId.trim() === '') {
    return { ok: false, reason: 'missing or empty projectId' }
  }
  const requestId = str(obj.requestId)
  if (requestId === undefined || requestId.trim() === '') {
    return { ok: false, reason: 'missing or empty requestId' }
  }

  const skillIds = Array.isArray(obj.skillIds)
    ? obj.skillIds.filter((s): s is string => typeof s === 'string')
    : []

  const task: TaskPayload = {
    projectId,
    requestId,
    skillIds,
    platform: str(obj.platform) ?? '',
    sourceLang: str(obj.sourceLang) ?? '',
    targetLang: str(obj.targetLang) ?? '',
    taskName: str(obj.taskName) ?? projectId,
    userCode: str(obj.userCode) ?? '',
    ...(str(obj.agentId) !== undefined ? { agentId: str(obj.agentId) } : {}),
    ...(typeof obj.__retries === 'number' ? { __retries: obj.__retries } : {}),
  }
  return { ok: true, task }
}

/** Coerce a value to a string when it is one, else undefined. */
function str(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}

/** Best-effort view of a raw payload as a task, for DLQ of invalid messages. */
function asTask(raw: unknown): TaskPayload {
  const obj = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>
  return {
    projectId: str(obj.projectId) ?? '',
    requestId: str(obj.requestId) ?? '',
    skillIds: [],
    platform: str(obj.platform) ?? '',
    sourceLang: str(obj.sourceLang) ?? '',
    targetLang: str(obj.targetLang) ?? '',
    taskName: str(obj.taskName) ?? '',
    userCode: str(obj.userCode) ?? '',
  }
}
