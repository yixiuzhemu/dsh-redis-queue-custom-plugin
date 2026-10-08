/**
 * Scheduler: a reversible interval timer (default 15s) that samples the
 * environment and, when it is within thresholds, drives the consumer.
 *
 * A re-entrancy flag guarantees an overlapping tick never runs while a previous
 * one is still in flight (a slow workspace-lock acquisition, for example), so
 * tasks are never dequeued faster than they are handled.
 *
 * @module dsh-redis-queue-custom-plugin/scheduler
 */

import type { Context } from '@deepseek-ai/cordis'
import { errorChain } from '@deepseek-ai/dsh-llm'
import type { QueueConfig } from './config.ts'
import type { EnvironmentMonitor } from './monitor.ts'
import type { TaskConsumer } from './consumer.ts'

export class Scheduler {
  private timer: ReturnType<typeof setInterval> | undefined
  private ticking = false

  constructor(
    private readonly ctx: Context,
    private readonly cfg: QueueConfig,
    private readonly monitor: EnvironmentMonitor,
    private readonly consumer: TaskConsumer,
  ) {}

  /**
   * Start the poll timer. Registered via `ctx.effect`; the returned disposer
   * stops it on unload/HMR. `unref()` keeps the timer from holding the process
   * open when the host is otherwise idle.
   */
  start(): () => void {
    this.timer = setInterval(() => {
      void this.tick()
    }, this.cfg.pollIntervalMs)
    this.timer.unref?.()
    return () => this.stop()
  }

  /** Stop the poll timer (idempotent). */
  stop(): void {
    if (this.timer !== undefined) clearInterval(this.timer)
    this.timer = undefined
  }

  /** One poll: gate on the environment, then consume up to `batchSize` tasks. */
  private async tick(): Promise<void> {
    if (this.ticking) return
    this.ticking = true
    try {
      const env = this.monitor.sample()
      if (!env.allowed) {
        this.ctx.logger.debug('[redis-queue] skip tick: %s', env.reason)
        return
      }
      for (let i = 0; i < this.cfg.batchSize; i++) {
        const consumed = await this.consumer.consumeOne()
        if (!consumed) break // queue empty
        // Re-gate after each task so one batch cannot push resources over.
        if (!this.monitor.sample().allowed) break
      }
    } catch (error: unknown) {
      this.ctx.logger.warn('[redis-queue] tick error: %s', errorChain(error))
    } finally {
      this.ticking = false
    }
  }
}
