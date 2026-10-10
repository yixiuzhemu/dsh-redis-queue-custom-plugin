import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Scheduler } from '../src/scheduler.ts'
import { resolveConfig, type QueueConfig } from '../src/config.ts'
import type { EnvironmentMonitor } from '../src/monitor.ts'
import type { TaskConsumer } from '../src/consumer.ts'
import type { QueueStore } from '../src/queue.ts'
import type { EnvSample } from '../src/types.ts'
import { createTestHost } from './stubs/host.ts'

function allowed(): EnvSample {
  return { cpuUsageRatio: 0, memoryUsageRatio: 0, runningSessions: 0, allowed: true }
}
function denied(reason: string): EnvSample {
  return { cpuUsageRatio: 0, memoryUsageRatio: 0, runningSessions: 0, allowed: false, reason }
}

/** A monitor whose `sample()` returns from a scripted sequence (last value repeats). */
function scriptedMonitor(samples: EnvSample[]): { monitor: EnvironmentMonitor; calls: () => number } {
  let i = 0
  const monitor = {
    sample: () => {
      const s = samples[Math.min(i, samples.length - 1)]!
      i++
      return s
    },
  } as unknown as EnvironmentMonitor
  return { monitor, calls: () => i }
}

function build(monitor: EnvironmentMonitor, consumer: TaskConsumer, cfgPatch: Partial<QueueConfig> = {}) {
  const host = createTestHost()
  const cfg = resolveConfig({ pollIntervalMs: 1000, ...cfgPatch })
  const queue = { len: vi.fn(async () => 0), processingLen: vi.fn(async () => 0), dlqLen: vi.fn(async () => 0) } as unknown as QueueStore
  const scheduler = new Scheduler(host.ctx, cfg, monitor, consumer, queue)
  return { host, cfg, scheduler }
}

describe('Scheduler', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('consumes one task per tick when the environment allows', async () => {
    const consumeOne = vi.fn(async () => true)
    const { monitor } = scriptedMonitor([allowed()])
    const { scheduler } = build(monitor, { consumeOne } as unknown as TaskConsumer)

    const dispose = scheduler.start()
    await vi.advanceTimersByTimeAsync(1000)
    expect(consumeOne).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1000)
    expect(consumeOne).toHaveBeenCalledTimes(2)
    dispose()
    await vi.advanceTimersByTimeAsync(1000)
    expect(consumeOne).toHaveBeenCalledTimes(2) // stopped
  })

  it('skips the tick entirely when the environment denies', async () => {
    const consumeOne = vi.fn(async () => true)
    const { monitor } = scriptedMonitor([denied('cpu 0.99 > 0.85')])
    const { scheduler, host } = build(monitor, { consumeOne } as unknown as TaskConsumer)

    scheduler.start()
    await vi.advanceTimersByTimeAsync(3000)
    expect(consumeOne).not.toHaveBeenCalled()
    expect(host.logText('debug')).toContain('skip tick')
  })

  it('stops a batch early when the queue is empty', async () => {
    const consumeOne = vi.fn(async () => false) // empty queue
    const { monitor } = scriptedMonitor([allowed()])
    const { scheduler } = build(monitor, { consumeOne } as unknown as TaskConsumer, { batchSize: 3 })

    scheduler.start()
    await vi.advanceTimersByTimeAsync(1000)
    expect(consumeOne).toHaveBeenCalledTimes(1) // broke after the first false
  })

  it('consumes up to batchSize per tick, re-gating after each task', async () => {
    const consumeOne = vi.fn(async () => true)
    const { monitor } = scriptedMonitor([allowed()])
    const { scheduler } = build(monitor, { consumeOne } as unknown as TaskConsumer, { batchSize: 2 })

    scheduler.start()
    await vi.advanceTimersByTimeAsync(1000)
    expect(consumeOne).toHaveBeenCalledTimes(2)
  })

  it('never overlaps ticks: a slow consume blocks the next tick (re-entrancy guard)', async () => {
    let release!: () => void
    const gate = new Promise<void>((r) => { release = r })
    let inFlight = 0
    let maxInFlight = 0
    const consumeOne = vi.fn(async () => {
      inFlight++
      maxInFlight = Math.max(maxInFlight, inFlight)
      await gate
      inFlight--
      return true
    })
    const { monitor } = scriptedMonitor([allowed()])
    const { scheduler } = build(monitor, { consumeOne } as unknown as TaskConsumer)

    scheduler.start()
    await vi.advanceTimersByTimeAsync(1000) // first tick starts, awaits the gate
    await vi.advanceTimersByTimeAsync(1000) // second tick fires while first is in flight
    await vi.advanceTimersByTimeAsync(1000)
    expect(consumeOne).toHaveBeenCalledTimes(1) // overlapping ticks were skipped
    expect(maxInFlight).toBe(1)

    release()
    await vi.advanceTimersByTimeAsync(0)
  })
})
