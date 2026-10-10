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
import { debugLog } from './debug.ts'

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
      debugLog(`[redis-queue] validation failed, sending to DLQ: ${result.reason}`)
      await this.deps.queue.toDlq(asTask(raw), result.reason)
      await this.deps.queue.ackBackup(raw)
      return true
    }
    const task = result.task
    debugLog(`[redis-queue] processing requestId=${task.requestId} projectId=${task.projectId}`)

    try {
      // Idempotency: a duplicate requestId means it is already running or done.
      const claim = await this.deps.idem.claim(task.requestId)
      if (claim.state === 'duplicate') {
        const dupMsg = `duplicate requestId=${task.requestId} (${claim.status}), skip`
        debugLog(`[redis-queue] ${dupMsg}`)
        this.ctx.logger.info('[redis-queue] %s', dupMsg)
        await this.deps.queue.ackBackup(raw)
        return true
      }
      debugLog(`[redis-queue] claimed requestId=${task.requestId}`)

      const workspace = await this.deps.workspaces.ensure(task.projectId)
      debugLog(`[redis-queue] workspace ready: ${workspace.id}`)
      const skillIds = await this.deps.skills.resolve(task.skillIds)
      debugLog(`[redis-queue] resolved ${skillIds.length} skill(s)`)
      const sessionId = await this.deps.launcher.launch({ task, workspace, skillIds })
      debugLog(`[redis-queue] launched session=${sessionId}`)
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
      const requeueMsg = `handling failed, requeued requestId=${task.requestId} retry=${retries + 1}: ${reason}`
      debugLog(`[redis-queue] ${requeueMsg}`)
      this.ctx.logger.warn('[redis-queue] %s', requeueMsg)
      return
    }
    const dlqMsg = `handling failed after ${retries} retries, sending to DLQ requestId=${task.requestId}: ${reason}`
    debugLog(`[redis-queue] ${dlqMsg}`)
    await this.deps.queue.toDlq(task, `handling failed after ${retries} retries: ${reason}`)
  }
}

/**
 * Validate a dequeued payload against the task schema. `projectId` and
 * `requestId` are mandatory; the remaining fields fall back to safe defaults so
 * a slightly-underfilled producer payload still processes (with the defaults
 * visible in the prompt).
 *
 * Tolerates double-encoded payloads: when a producer pushes a JSON string
 * (instead of an object) and the codec's `JSON.parse` returns a string, we
 * attempt one more `JSON.parse` to unwrap it. This handles the common case
 * where a non-dsh producer or a redis-cli push stores a stringified JSON
 * object that the dsh-redis-plugin codec then deserializes as a string.
 *
 * @param raw - the decoded queue element.
 * @returns the normalized task, or a reason when it is a poison message.
 */
export function validateTask(raw: unknown): ValidateResult {
  // Tolerate double-encoded payloads: if the codec returned a string, try
  // parsing it once more to unwrap the inner JSON object.
  let payload = raw
  if (typeof payload === 'string') {
    try {
      payload = JSON.parse(payload)
    } catch {
      return { ok: false, reason: `payload is a string but not valid JSON: ${(payload as string).slice(0, 120)}` }
    }
  }

  if (typeof payload !== 'object' || payload === null) {
    return { ok: false, reason: `payload is not an object (got ${typeof payload})` }
  }
  const obj = payload as Record<string, unknown>

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
    ...(str(obj.provider) !== undefined ? { provider: str(obj.provider) } : {}),
    ...(str(obj.model) !== undefined ? { model: str(obj.model) } : {}),
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
