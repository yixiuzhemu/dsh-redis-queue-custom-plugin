/**
 * Environment monitor: samples CPU, system memory, and the running-session count
 * and decides whether the consumer may take another task.
 *
 * CPU utilization is derived from `os.cpus()` idle/total deltas (reliable across
 * platforms; `os.loadavg()` is not meaningful on Windows). A baseline snapshot is
 * taken on start and refreshed each sample, so the ratio reflects the window
 * between two reads.
 *
 * @module dsh-redis-queue-custom-plugin/monitor
 */

import { cpus, freemem, totalmem } from 'node:os'
import type { Context } from '@deepseek-ai/cordis'
import type { QueueConfig } from './config.ts'
import type { EnvSample } from './types.ts'
import type { ActiveSessionTracker } from './tracker.ts'

/** A cumulative CPU tick snapshot (idle vs total jiffies across all cores). */
interface CpuSnapshot {
  readonly idle: number
  readonly total: number
}

export class EnvironmentMonitor {
  private prev: CpuSnapshot | undefined
  private timer: ReturnType<typeof setInterval> | undefined

  constructor(
    private readonly ctx: Context,
    private readonly cfg: QueueConfig,
    private readonly tracker: ActiveSessionTracker,
  ) {}

  /**
   * Establish the CPU delta baseline and start a periodic refresher driven by
   * `thresholds.cpuSampleWindowMs`. `sample()` is a pure read against `prev`,
   * so the sampling window is stable regardless of how often the scheduler
   * calls it (multiple times per tick, or ticks skipped by the gate).
   *
   * Registered via `ctx.effect`; the returned disposer stops the timer.
   */
  start(): () => void {
    this.prev = this.snapshotCpu()
    const windowMs = Math.max(1, this.cfg.thresholds.cpuSampleWindowMs)
    this.timer = setInterval(() => {
      this.prev = this.snapshotCpu()
    }, windowMs)
    this.timer.unref?.()
    return () => {
      if (this.timer !== undefined) clearInterval(this.timer)
      this.timer = undefined
      this.prev = undefined
    }
  }

  /** Sum idle and total jiffies across every core. */
  private snapshotCpu(): CpuSnapshot {
    let idle = 0
    let total = 0
    for (const c of cpus()) {
      idle += c.times.idle
      total += c.times.user + c.times.nice + c.times.sys + c.times.idle + c.times.irq
    }
    return { idle, total }
  }

  /**
   * CPU utilization between the last periodic snapshot and now. Pure read —
   * does NOT advance `prev` (the sampling-window timer owns that), so repeated
   * calls within one window return the same value.
   */
  private computeCpu(): number {
    const prev = this.prev
    if (prev === undefined) return 0
    const now = this.snapshotCpu()
    const totalDelta = now.total - prev.total
    const idleDelta = now.idle - prev.idle
    if (totalDelta <= 0) return 0
    return Math.min(1, Math.max(0, 1 - idleDelta / totalDelta))
  }

  /**
   * Take one environment sample and decide admission.
   * @returns the metrics plus whether consuming is allowed (and why not).
   */
  sample(): EnvSample {
    const cpuUsageRatio = this.computeCpu()
    const total = totalmem()
    const memoryUsageRatio = total > 0 ? 1 - freemem() / total : 0
    const runningSessions = this.tracker.running()
    const t = this.cfg.thresholds

    let reason: string | undefined
    if (cpuUsageRatio > t.maxCpuUsageRatio) {
      reason = `cpu ${cpuUsageRatio.toFixed(2)} > ${t.maxCpuUsageRatio}`
    } else if (memoryUsageRatio > t.maxMemoryUsageRatio) {
      reason = `mem ${memoryUsageRatio.toFixed(2)} > ${t.maxMemoryUsageRatio}`
    } else if (runningSessions >= t.maxConcurrentSessions) {
      reason = `sessions ${runningSessions} >= ${t.maxConcurrentSessions}`
    }

    return {
      cpuUsageRatio,
      memoryUsageRatio,
      runningSessions,
      allowed: reason === undefined,
      ...(reason !== undefined ? { reason } : {}),
    }
  }
}
