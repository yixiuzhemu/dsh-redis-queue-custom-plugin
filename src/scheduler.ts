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
import type { QueueStore } from './queue.ts'
import { debugLog } from './debug.ts'

/**
 * Build a human-readable Redis connection label from environment variables.
 * The dsh-redis-plugin reads the same REDIS_* vars (via cordis config
 * substitution), so this reflects the actual connection target without
 * needing to reach into the plugin's internal config.
 * - If REDIS_URL is set, the URL is returned as-is (credentials are NOT
 *   stripped here — the deployer controls what REDIS_URL contains).
 * - Otherwise host:port/db is assembled with the same defaults the plugin
 *   uses (127.0.0.1:6379/0).
 * - keyPrefix (REDIS_KEY_PREFIX) is appended so namespace mismatches are
 *   immediately visible in scan logs.
 */
function resolveRedisTarget(): string {
  const url = process.env.REDIS_URL
  if (url) return url
  const host = process.env.REDIS_HOST || '127.0.0.1'
  const port = process.env.REDIS_PORT || '6379'
  const db = process.env.REDIS_DB || '0'
  const keyPrefix = process.env.REDIS_KEY_PREFIX || ''
  return `${host}:${port}/${db}${keyPrefix ? ` keyPrefix=${keyPrefix}` : ''}`
}

export class Scheduler {
  private timer: ReturnType<typeof setInterval> | undefined
  private ticking = false
  /** Redis connection label resolved once from env vars (same source dsh-redis-plugin reads). */
  private readonly redisTarget: string

  constructor(
    private readonly ctx: Context,
    private readonly cfg: QueueConfig,
    private readonly monitor: EnvironmentMonitor,
    private readonly consumer: TaskConsumer,
    private readonly queue: QueueStore,
  ) {
    this.redisTarget = resolveRedisTarget()
  }

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
      // Scan and print queue information before consuming.
      // Uses debugLog (stdout) so output is visible only when LOG_LEVEL=debug.
      // The desktop host spawns the host process and pipes only child stdout
      // to the terminal (stderr is buffered and dropped), while the CLI path
      // shows stdout directly. ctx.logger writes to a Cordis ring buffer that
      // neither path exports, so it is kept only for structured use.
      try {
        const queueLen = await this.queue.len()
        const processingLen = await this.queue.processingLen()
        const dlqLen = await this.queue.dlqLen()
        const scanMsg = `scan: redis=${this.redisTarget} queue=${this.cfg.queueKey} len=${queueLen} processing=${processingLen} dlq=${dlqLen}`
        debugLog(`[redis-queue] ${scanMsg}`)
        this.ctx.logger.info('[redis-queue] %s', scanMsg)
      } catch (scanErr: unknown) {
        const errMsg = `queue scan error: ${errorChain(scanErr)}`
        debugLog(`[redis-queue] ${errMsg}`)
        this.ctx.logger.warn('[redis-queue] %s', errMsg)
      }

      const env = this.monitor.sample()
      if (!env.allowed) {
        const skipMsg = `skip tick: ${env.reason}`
        debugLog(`[redis-queue] ${skipMsg}`)
        this.ctx.logger.debug('[redis-queue] %s', skipMsg)
        return
      }
      for (let i = 0; i < this.cfg.batchSize; i++) {
        const consumed = await this.consumer.consumeOne()
        if (!consumed) {
          debugLog('[redis-queue] queue empty, stop batch')
          break // queue empty
        }
        debugLog(`[redis-queue] consumed task ${i + 1}/${this.cfg.batchSize}`)
        // Re-gate after each task so one batch cannot push resources over.
        if (!this.monitor.sample().allowed) break
      }
    } catch (error: unknown) {
      const errMsg = `tick error: ${errorChain(error)}`
      debugLog(`[redis-queue] ${errMsg}`)
      this.ctx.logger.warn('[redis-queue] %s', errMsg)
    } finally {
      this.ticking = false
    }
  }
}
