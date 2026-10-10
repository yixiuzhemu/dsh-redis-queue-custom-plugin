/**
 * Redis queue operations: dequeue, processing-backup, ack, requeue, and
 * dead-letter. Encapsulated so both the consumer and the tracker share one
 * consistent encoding path (a value we push is byte-identical to one we lRem).
 *
 * @module dsh-redis-queue-custom-plugin/queue
 */

import type { Context } from '@deepseek-ai/cordis'
import type { QueueConfig } from './config.ts'
import type { TaskPayload } from './types.ts'

/** A DLQ envelope wrapping a poison/failed task with its failure context. */
export interface DeadLetterEnvelope {
  readonly task: TaskPayload
  readonly reason: string
  readonly at: string
}

export class QueueStore {
  constructor(
    private readonly ctx: Context,
    private readonly cfg: QueueConfig,
  ) {}

  /**
   * Dequeue one task, honoring the configured mode/direction.
   * @returns the decoded payload, or null when the queue is empty (or a blocking
   *   pop timed out).
   */
  async pop(): Promise<TaskPayload | null> {
    const redis = this.ctx.redis
    if (this.cfg.consumeMode === 'blocking') {
      const res = await redis.brPop<TaskPayload>(this.cfg.queueKey, this.cfg.blockingTimeoutSec)
      return res === null ? null : res[1]
    }
    return this.cfg.fifo
      ? await redis.lPop<TaskPayload>(this.cfg.queueKey)
      : await redis.rPop<TaskPayload>(this.cfg.queueKey)
  }

  /** Current queue depth (diagnostics / optional pre-check). */
  async len(): Promise<number> {
    return this.ctx.redis.lLen(this.cfg.queueKey)
  }

  /** Number of tasks currently in the processing-backup list (crash recovery). */
  async processingLen(): Promise<number> {
    return this.ctx.redis.lLen(this.cfg.processingKey)
  }

  /** Number of tasks in the dead-letter list. */
  async dlqLen(): Promise<number> {
    return this.ctx.redis.lLen(this.cfg.deadLetterKey)
  }

  /** Push a popped task onto the processing-backup list (crash recovery). */
  async backup(task: TaskPayload): Promise<void> {
    await this.ctx.redis.rPush(this.cfg.processingKey, task)
  }

  /** Remove one matching task from the processing-backup list (ack). */
  async ackBackup(task: TaskPayload): Promise<void> {
    await this.ctx.redis.lRem(this.cfg.processingKey, 1, task)
  }

  /**
   * Re-queue a task for another attempt, bumping its internal retry counter.
   * Pushed to the head (lPush) so a retry is picked up before newer work.
   * @param task - the task to requeue.
   * @param retries - the retry count to stamp (already incremented by caller).
   */
  async requeue(task: TaskPayload, retries: number): Promise<void> {
    await this.ctx.redis.lPush(this.cfg.queueKey, { ...task, __retries: retries })
  }

  /** Send a task to the dead-letter list with its failure context. */
  async toDlq(task: TaskPayload, reason: string): Promise<void> {
    const envelope: DeadLetterEnvelope = { task, reason, at: new Date().toISOString() }
    await this.ctx.redis.rPush(this.cfg.deadLetterKey, envelope)
    this.ctx.logger.error('[redis-queue] task sent to DLQ requestId=%s reason=%s', task.requestId, reason)
  }
}
