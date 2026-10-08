import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ActiveSessionTracker } from '../src/tracker.ts'
import { IdempotencyGuard } from '../src/idempotency.ts'
import { QueueStore } from '../src/queue.ts'
import { resolveConfig, type QueueConfig } from '../src/config.ts'
import type { TaskPayload } from '../src/types.ts'
import { createTestHost } from './stubs/host.ts'

const task: TaskPayload = {
  platform: 'Chiao',
  projectId: 'P1',
  requestId: 'req-1',
  skillIds: [],
  sourceLang: 'zh',
  targetLang: 'en',
  taskName: 't',
  userCode: 'S1',
}

function setup(cfgPatch: Partial<QueueConfig> = {}) {
  const host = createTestHost()
  const cfg = resolveConfig(cfgPatch)
  const idem = new IdempotencyGuard(host.ctx, cfg)
  const queue = new QueueStore(host.ctx, cfg)
  const tracker = new ActiveSessionTracker(host.ctx, cfg, idem, queue)
  tracker.start()
  return { host, cfg, idem, queue, tracker }
}

describe('ActiveSessionTracker', () => {
  it('counts a tracked session toward the concurrency gate', () => {
    const { tracker } = setup()
    expect(tracker.running()).toBe(0)
    tracker.track('sess-1', { requestId: 'req-1', backup: task, task })
    expect(tracker.running()).toBe(1)
  })

  it('settles as done on turn/end: marks idempotency done and acks the backup', async () => {
    const { host, cfg, tracker } = setup()
    await host.redis.rPush(cfg.processingKey, task) // in-flight backup
    tracker.track('sess-1', { requestId: 'req-1', backup: task, task })

    host.emit('session/event', { header: { id: 'sess-1' } }, { type: 'turn/end' })
    await flush()

    expect(tracker.running()).toBe(0)
    expect(host.redis.peekString(`${cfg.idempotency.keyPrefix}:req-1`)).toBe('done:sess-1')
    expect(host.redis.peekList(cfg.processingKey)).toEqual([]) // backup acked
  })

  it('ignores completion events for sessions it does not track', async () => {
    const { host, tracker } = setup()
    tracker.track('sess-1', { requestId: 'req-1', backup: task, task })
    host.emit('session/event', { header: { id: 'unknown' } }, { type: 'turn/end' })
    await flush()
    expect(tracker.running()).toBe(1)
  })

  it('ignores non turn/end session events', async () => {
    const { host, tracker } = setup()
    tracker.track('sess-1', { requestId: 'req-1', backup: task, task })
    host.emit('session/event', { header: { id: 'sess-1' } }, { type: 'turn/start' })
    await flush()
    expect(tracker.running()).toBe(1)
  })

  it('requeues on agent/error under the retry cap and releases the claim', async () => {
    const { host, cfg, tracker } = setup({ maxRetries: 3 })
    await host.redis.setIfAbsent(`${cfg.idempotency.keyPrefix}:req-1`, 'processing')
    await host.redis.rPush(cfg.processingKey, task)
    tracker.track('sess-1', { requestId: 'req-1', backup: task, task })

    host.emit('agent/error', { agent: { session: { id: 'sess-1' } }, error: new Error('boom') })
    await flush()

    expect(tracker.running()).toBe(0)
    expect(host.redis.peekString(`${cfg.idempotency.keyPrefix}:req-1`)).toBeUndefined() // released
    expect(host.redis.peekList(cfg.processingKey)).toEqual([]) // acked
    const requeued = host.redis.peekList(cfg.queueKey) as TaskPayload[]
    expect(requeued).toHaveLength(1)
    expect(requeued[0]?.__retries).toBe(1)
  })

  it('dead-letters on agent/error once retries are exhausted', async () => {
    const { host, cfg, tracker } = setup({ maxRetries: 1 })
    const exhausted: TaskPayload = { ...task, __retries: 1 }
    await host.redis.rPush(cfg.processingKey, exhausted)
    tracker.track('sess-1', { requestId: 'req-1', backup: exhausted, task: exhausted })

    host.emit('agent/error', { agent: { header: { id: 'sess-1' } }, error: new Error('boom') })
    await flush()

    expect(host.redis.peekList(cfg.queueKey)).toEqual([]) // not requeued
    expect(host.redis.peekList(cfg.deadLetterKey)).toHaveLength(1)
  })
})

describe('ActiveSessionTracker stuck-session sweep (D3)', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  function setupTimed(cfgPatch: Partial<QueueConfig> = {}) {
    const host = createTestHost()
    const cfg = resolveConfig({
      sessionMaxLifetimeMs: 5_000,
      sessionSweepIntervalMs: 1_000,
      ...cfgPatch,
    })
    const idem = new IdempotencyGuard(host.ctx, cfg)
    const queue = new QueueStore(host.ctx, cfg)
    const tracker = new ActiveSessionTracker(host.ctx, cfg, idem, queue)
    const dispose = tracker.start()
    return { host, cfg, idem, queue, tracker, dispose }
  }

  it('keeps a fresh session tracked before the max-lifetime elapses', () => {
    const { tracker, dispose } = setupTimed()
    tracker.track('sess-1', { requestId: 'req-1', backup: task, task })
    vi.advanceTimersByTime(3_000) // sweep runs at t=1s,2s,3s but age < 5s
    expect(tracker.running()).toBe(1)
    dispose()
  })

  it('releases the gate slot once a session exceeds sessionMaxLifetimeMs', async () => {
    const { host, cfg, tracker, dispose } = setupTimed()
    await host.redis.setIfAbsent(`${cfg.idempotency.keyPrefix}:req-1`, 'processing')
    await host.redis.rPush(cfg.processingKey, task)
    tracker.track('sess-1', { requestId: 'req-1', backup: task, task })

    vi.advanceTimersByTime(6_000) // age > 5s → next sweep drops it
    expect(tracker.running()).toBe(0)
    expect(host.logText('warn')).toContain('exceeded max lifetime')

    // The sweep must NOT touch idempotency or the processing backup, so a late
    // turn/end cannot trigger a duplicate execution via a re-pickup.
    expect(host.redis.peekString(`${cfg.idempotency.keyPrefix}:req-1`)).toBe('processing')
    expect(host.redis.peekList(cfg.processingKey)).toHaveLength(1)
    expect(host.redis.peekList(cfg.queueKey)).toEqual([]) // not requeued
    dispose()
  })

  it('a late turn/end after the sweep is a no-op (already released)', async () => {
    const { host, cfg, tracker, dispose } = setupTimed()
    await host.redis.rPush(cfg.processingKey, task)
    tracker.track('sess-1', { requestId: 'req-1', backup: task, task })
    vi.advanceTimersByTime(6_000)
    expect(tracker.running()).toBe(0)

    host.emit('session/event', { header: { id: 'sess-1' } }, { type: 'turn/end' })
    await flush()
    // Idempotency untouched (sweep does not release; late done does not re-mark).
    expect(host.redis.peekString(`${cfg.idempotency.keyPrefix}:req-1`)).toBeUndefined()
    expect(host.redis.peekList(cfg.processingKey)).toHaveLength(1)
    dispose()
  })

  it('the disposer clears the tracked map and warns about abandoned sessions', () => {
    const { host, tracker, dispose } = setupTimed()
    tracker.track('sess-1', { requestId: 'req-1', backup: task, task })
    tracker.track('sess-2', { requestId: 'req-2', backup: task, task })
    expect(tracker.running()).toBe(2)

    dispose()
    expect(tracker.running()).toBe(0)
    const warn = host.logText('warn')
    expect(warn).toContain('tracker disposed with')
    expect(warn).toContain('in-flight session(s)')
    // The count is passed as a printf-style arg (not interpolated by the stub);
    // assert on the raw log entry to catch it.
    const disposedEntry = host.logs.find(
      (l) => l.level === 'warn' && typeof l.args[0] === 'string' && l.args[0].includes('tracker disposed with'),
    )
    expect(disposedEntry?.args[1]).toBe(2)
  })

  it('the disposer is idempotent and stops the sweep timer', () => {
    const { tracker, dispose } = setupTimed()
    tracker.track('sess-1', { requestId: 'req-1', backup: task, task })
    dispose()
    // A second call must not throw and must not resurrect the timer.
    expect(() => dispose()).not.toThrow()
    vi.advanceTimersByTime(10_000)
    expect(tracker.running()).toBe(0)
  })
})

/** Let the fire-and-forget settle promise chain run to completion. */
async function flush(): Promise<void> {
  for (let i = 0; i < 5; i++) await Promise.resolve()
}
