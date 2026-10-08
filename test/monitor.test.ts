import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { EnvironmentMonitor } from '../src/monitor.ts'
import { resolveConfig, type QueueConfig } from '../src/config.ts'
import { createTestHost } from './stubs/host.ts'
import type { ActiveSessionTracker } from '../src/tracker.ts'

// Controllable OS metrics so every admission branch is deterministic.
const os = vi.hoisted(() => ({
  idle: 0,
  total: 100,
  free: 1000,
  memTotal: 1000,
}))

vi.mock('node:os', () => ({
  cpus: () => [{ times: { idle: os.idle, user: os.total - os.idle, nice: 0, sys: 0, irq: 0 } }],
  freemem: () => os.free,
  totalmem: () => os.memTotal,
  homedir: () => '/home/test',
}))

/** Set the cumulative CPU tick snapshot (single core). */
function setCpu(idle: number, total: number): void {
  os.idle = idle
  os.total = total
}

function setMem(free: number, total: number): void {
  os.free = free
  os.memTotal = total
}

function fakeTracker(running: number): ActiveSessionTracker {
  return { running: () => running } as unknown as ActiveSessionTracker
}

function monitor(thresholds: Partial<QueueConfig['thresholds']>, running: number): EnvironmentMonitor {
  const host = createTestHost()
  const cfg = resolveConfig({ thresholds })
  return new EnvironmentMonitor(host.ctx, cfg, fakeTracker(running))
}

describe('EnvironmentMonitor.sample', () => {
  it('reports cpu=0 when no delta has elapsed since the baseline', () => {
    setCpu(0, 100)
    setMem(1000, 1000)
    const m = monitor({}, 0)
    m.start()
    const s = m.sample()
    expect(s.cpuUsageRatio).toBe(0)
    expect(s.allowed).toBe(true)
  })

  it('denies when cpu utilization exceeds the threshold', () => {
    setCpu(0, 100)
    setMem(1000, 1000)
    const m = monitor({ maxCpuUsageRatio: 0.85, maxMemoryUsageRatio: 1 }, 0)
    m.start()
    setCpu(10, 200) // Δidle 10 / Δtotal 100 → 0.9 utilization
    const s = m.sample()
    expect(s.cpuUsageRatio).toBeCloseTo(0.9, 5)
    expect(s.allowed).toBe(false)
    expect(s.reason).toContain('cpu')
  })

  it('denies when memory utilization exceeds the threshold', () => {
    setCpu(0, 100)
    setMem(50, 1000) // 0.95 used
    const m = monitor({ maxCpuUsageRatio: 1, maxMemoryUsageRatio: 0.9 }, 0)
    m.start()
    setCpu(90, 200) // cpu delta ~0.1, under threshold
    const s = m.sample()
    expect(s.memoryUsageRatio).toBeCloseTo(0.95, 5)
    expect(s.allowed).toBe(false)
    expect(s.reason).toContain('mem')
  })

  it('denies when the running-session count reaches the cap', () => {
    setCpu(0, 100)
    setMem(1000, 1000)
    const m = monitor({ maxCpuUsageRatio: 1, maxMemoryUsageRatio: 1, maxConcurrentSessions: 2 }, 2)
    m.start()
    setCpu(90, 200)
    const s = m.sample()
    expect(s.runningSessions).toBe(2)
    expect(s.allowed).toBe(false)
    expect(s.reason).toContain('sessions')
  })

  it('allows when every metric is within thresholds', () => {
    setCpu(0, 100)
    setMem(900, 1000)
    const m = monitor({ maxCpuUsageRatio: 0.85, maxMemoryUsageRatio: 0.9, maxConcurrentSessions: 3 }, 1)
    m.start()
    setCpu(90, 200)
    const s = m.sample()
    expect(s.allowed).toBe(true)
    expect(s.reason).toBeUndefined()
  })
})

describe('EnvironmentMonitor cpu sampling window (D2)', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    setCpu(0, 100)
    setMem(1000, 1000)
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  function monitored(windowMs: number): { m: EnvironmentMonitor; dispose: () => void } {
    const host = createTestHost()
    const cfg = resolveConfig({ thresholds: { cpuSampleWindowMs: windowMs, maxCpuUsageRatio: 1, maxMemoryUsageRatio: 1 } })
    const m = new EnvironmentMonitor(host.ctx, cfg, fakeTracker(0))
    const dispose = m.start()
    return { m, dispose }
  }

  it('sample() is a pure read — repeated calls within one window return the same ratio', () => {
    const { m, dispose } = monitored(1000)
    setCpu(10, 200) // Δidle 10 / Δtotal 100 → 0.9 utilization
    const first = m.sample()
    const second = m.sample()
    const third = m.sample()
    expect(first.cpuUsageRatio).toBeCloseTo(0.9, 5)
    expect(second.cpuUsageRatio).toBeCloseTo(0.9, 5)
    expect(third.cpuUsageRatio).toBeCloseTo(0.9, 5)
    dispose()
  })

  it('refreshes the baseline every cpuSampleWindowMs so the ratio tracks the configured window', () => {
    const { m, dispose } = monitored(1000)
    setCpu(10, 200)
    expect(m.sample().cpuUsageRatio).toBeCloseTo(0.9, 5)
    // Advance past one window: the periodic refresher takes a new baseline at
    // the current cpus() reading, so the next sample sees no delta → 0.
    vi.advanceTimersByTime(1000)
    expect(m.sample().cpuUsageRatio).toBe(0)
    // A further delta accumulates against the refreshed baseline.
    setCpu(30, 300) // Δidle 20 / Δtotal 100 → 0.8 utilization
    expect(m.sample().cpuUsageRatio).toBeCloseTo(0.8, 5)
    dispose()
  })

  it('stop() (the disposer) clears the sampling-window timer', () => {
    const { m, dispose } = monitored(1000)
    setCpu(10, 200)
    dispose()
    // After disposal the timer must not fire again; advancing time is a no-op.
    setCpu(50, 500)
    vi.advanceTimersByTime(5000)
    // A fresh sample after dispose returns 0 because prev is cleared.
    expect(m.sample().cpuUsageRatio).toBe(0)
  })
})
