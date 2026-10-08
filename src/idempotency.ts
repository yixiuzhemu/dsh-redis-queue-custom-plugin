/**
 * Idempotency guard: an atomic `SET NX` claim keyed by `requestId` so one task
 * executes at most once across restarts, retries, and multiple consumers.
 *
 * State machine: `processing` (short TTL, auto-releases on crash) → `done:{id}`
 * (long TTL, guards against replay). A recoverable failure releases the claim so
 * a requeued task can re-acquire it.
 *
 * @module dsh-redis-queue-custom-plugin/idempotency
 */

import type { Context } from '@deepseek-ai/cordis'
import type { QueueConfig } from './config.ts'

/** Outcome of a claim attempt. */
export type ClaimResult =
  | { readonly state: 'acquired' }
  | { readonly state: 'duplicate'; readonly status: string }

export class IdempotencyGuard {
  constructor(
    private readonly ctx: Context,
    private readonly cfg: QueueConfig,
  ) {}

  private key(requestId: string): string {
    return `${this.cfg.idempotency.keyPrefix}:${requestId}`
  }

  /**
   * Atomically claim a requestId. Success means this is the first live attempt;
   * a duplicate means it is already processing or already done.
   * @param requestId - the task's session id.
   * @returns the claim outcome (with the existing status when duplicated).
   */
  async claim(requestId: string): Promise<ClaimResult> {
    const key = this.key(requestId)
    const ok = await this.ctx.redis.setIfAbsent(key, 'processing', this.cfg.idempotency.processingTtlMs, 'ms')
    if (ok) return { state: 'acquired' }
    const existing = await this.ctx.redis.get<string>(key)
    return { state: 'duplicate', status: existing === null ? 'unknown' : String(existing) }
  }

  /**
   * Mark a claim as successfully completed, extending its TTL so a late replay
   * of the same requestId is still recognized as done.
   * @param requestId - the task's session id.
   * @param sessionId - the launched session, recorded for traceability.
   */
  async markDone(requestId: string, sessionId: string): Promise<void> {
    await this.ctx.redis.setEx(this.key(requestId), `done:${sessionId}`, this.cfg.idempotency.doneTtlMs, 'ms')
  }

  /**
   * Release an in-flight claim so a requeued task can be retried. Only used on
   * recoverable failures; a done claim is never released.
   * @param requestId - the task's session id.
   */
  async release(requestId: string): Promise<void> {
    await this.ctx.redis.del(this.key(requestId))
  }
}
