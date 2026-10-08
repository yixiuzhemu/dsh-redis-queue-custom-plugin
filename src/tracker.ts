/**
 * Active-session tracker: counts in-flight sessions (the environment gate's
 * "running sessions" metric) and settles them on completion or error.
 *
 * Settlement drives the idempotency state machine and the processing backup:
 * a completed first turn marks the claim `done` and acks the backup; an error
 * releases the claim and requeues (or dead-letters) the task.
 *
 * @module dsh-redis-queue-custom-plugin/tracker
 */

import type { Context } from '@deepseek-ai/cordis'
import { errorChain } from '@deepseek-ai/dsh-llm'
import type { QueueConfig } from './config.ts'
import type { IdempotencyGuard } from './idempotency.ts'
import type { QueueStore } from './queue.ts'
import type { TrackedMeta, TrackedSession } from './types.ts'

export class ActiveSessionTracker {
  private readonly active = new Map<string, TrackedSession>()
  private sweepTimer: ReturnType<typeof setInterval> | undefined

  constructor(
    private readonly ctx: Context,
    private readonly cfg: QueueConfig,
    private readonly idem: IdempotencyGuard,
    private readonly queue: QueueStore,
  ) {}

  /**
   * Subscribe to host completion/error events and start the stuck-session
   * sweeper. Registered via `ctx.effect`, so the returned disposer
   * unsubscribes, stops the sweeper, and drops any still-tracked sessions
   * (their idempotency claims age out via `processingTtlMs`; the host owns
   * their lifecycle after unload).
   */
  start(): () => void {
    const offEvent = this.ctx.on('session/event', (session: unknown, event: { type?: string }) => {
      if (event?.type !== 'turn/end') return
      const id = sessionIdOf(session)
      if (id !== undefined) void this.settle(id, 'done')
    })
    const offError = this.ctx.on('agent/error', (payload: { agent?: unknown; error?: unknown }) => {
      const id = sessionIdOf(payload?.agent)
      if (id !== undefined) void this.settle(id, 'error', payload?.error)
    })

    const sweepIntervalMs = Math.max(1000, this.cfg.sessionSweepIntervalMs)
    this.sweepTimer = setInterval(() => {
      this.sweep()
    }, sweepIntervalMs)
    this.sweepTimer.unref?.()

    return () => {
      offEvent()
      offError()
      if (this.sweepTimer !== undefined) clearInterval(this.sweepTimer)
      this.sweepTimer = undefined
      const abandoned = this.active.size
      this.active.clear()
      if (abandoned > 0) {
        this.ctx.logger.warn(
          '[redis-queue] tracker disposed with %d in-flight session(s); idempotency claims will age out via processingTtlMs',
          abandoned,
        )
      }
    }
  }

  /** Number of sessions launched and not yet settled (the concurrency gate). */
  running(): number {
    return this.active.size
  }

  /** Begin tracking a launched session so it counts toward the gate. */
  track(sessionId: string, meta: TrackedMeta): void {
    this.active.set(sessionId, { sessionId, startedAt: Date.now(), ...meta })
  }

  /**
   * Drop sessions that have been in-flight longer than `sessionMaxLifetimeMs`.
   * Only the concurrency slot is released — the idempotency claim and the
   * processing backup are left untouched so a late `turn/end` cannot cause a
   * duplicate execution if the same requestId is redelivered.
   */
  private sweep(): void {
    const now = Date.now()
    const limit = this.cfg.sessionMaxLifetimeMs
    for (const [sessionId, rec] of this.active) {
      if (now - rec.startedAt < limit) continue
      this.active.delete(sessionId)
      this.ctx.logger.warn(
        '[redis-queue] tracked session exceeded max lifetime, releasing gate slot sessionId=%s requestId=%s ageMs=%d',
        sessionId,
        rec.requestId,
        now - rec.startedAt,
      )
    }
  }

  /**
   * Settle a tracked session exactly once, releasing the concurrency slot and
   * finalizing idempotency + backup. Unknown ids are ignored (not ours).
   * @param sessionId - the session that completed or errored.
   * @param outcome - `done` (first turn ended) or `error` (agent error).
   * @param error - the original error when outcome is `error`.
   */
  private async settle(sessionId: string, outcome: 'done' | 'error', error?: unknown): Promise<void> {
    const rec = this.active.get(sessionId)
    if (rec === undefined) return
    this.active.delete(sessionId)

    if (outcome === 'done') {
      await this.idem.markDone(rec.requestId, sessionId)
      await this.queue.ackBackup(rec.backup)
      this.ctx.logger.info('[redis-queue] task done requestId=%s session=%s', rec.requestId, sessionId)
      return
    }

    // Error path: release the claim and retry or dead-letter.
    const reason = errorChain(error)
    const retries = rec.task.__retries ?? 0
    await this.idem.release(rec.requestId)
    await this.queue.ackBackup(rec.backup)
    if (this.cfg.requeueOnFailure && retries < this.cfg.maxRetries) {
      await this.queue.requeue(rec.task, retries + 1)
      this.ctx.logger.warn(
        '[redis-queue] session error, requeued requestId=%s retry=%d: %s',
        rec.requestId,
        retries + 1,
        reason,
      )
    } else {
      await this.queue.toDlq(rec.task, `session error after ${retries} retries: ${reason}`)
    }
  }
}

/** Extract a session id from a host session or agent reference. */
function sessionIdOf(ref: unknown): string | undefined {
  const header = (ref as { header?: { id?: string } })?.header
  if (header?.id !== undefined) return String(header.id)
  const session = (ref as { session?: { id?: string } })?.session
  if (session?.id !== undefined) return String(session.id)
  return undefined
}
