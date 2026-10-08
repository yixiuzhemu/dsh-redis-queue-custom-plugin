import { describe, expect, it, vi } from 'vitest'
import { TaskConsumer, validateTask } from '../src/consumer.ts'
import { QueueStore } from '../src/queue.ts'
import { IdempotencyGuard } from '../src/idempotency.ts'
import { WorkspaceProvisioner } from '../src/workspace.ts'
import { SkillResolver } from '../src/skills.ts'
import { SessionLauncher } from '../src/launcher.ts'
import { ActiveSessionTracker } from '../src/tracker.ts'
import { resolveConfig, type QueueConfig } from '../src/config.ts'
import type { TaskPayload } from '../src/types.ts'
import { createTestHost, sampleTask, type TestHostOptions } from './stubs/host.ts'

vi.mock('node:fs/promises', () => ({ mkdir: vi.fn(async () => undefined) }))

const ROOT = '/tmp/dsh-rq-consumer'

function setup(opts: TestHostOptions = {}, cfgPatch: Partial<QueueConfig> = {}) {
  const host = createTestHost({
    // Skills-Manager fetches each external skillId by id; the registry is
    // name-addressed, so knownSkills is keyed by the resolved record names.
    skillsManager: {
      resolveSkillById: async (id: string) =>
        [{ id: '1', name: 's1' }, { id: '2', name: 's2' }].find((r) => r.id === id),
    },
    knownSkills: { s1: { name: 's1', description: 'd1' }, s2: { name: 's2', description: 'd2' } },
    ...opts,
  })
  const cfg = resolveConfig({ workspaceRoot: ROOT, lock: { retryCount: 3, retryIntervalMs: 1 }, ...cfgPatch })
  const queue = new QueueStore(host.ctx, cfg)
  const idem = new IdempotencyGuard(host.ctx, cfg)
  const workspaces = new WorkspaceProvisioner(host.ctx, cfg)
  const skills = new SkillResolver(host.ctx)
  const launcher = new SessionLauncher(host.ctx, cfg)
  const tracker = new ActiveSessionTracker(host.ctx, cfg, idem, queue)
  tracker.start()
  const consumer = new TaskConsumer(host.ctx, cfg, { queue, idem, workspaces, skills, launcher, tracker })
  return { host, cfg, queue, idem, tracker, consumer }
}

describe('validateTask', () => {
  it('accepts a well-formed payload and normalizes defaults', () => {
    const res = validateTask(sampleTask({ taskName: undefined }))
    expect(res.ok).toBe(true)
    if (res.ok) expect(res.task.taskName).toBe(res.task.projectId) // falls back to projectId
  })

  it.each([
    ['not an object', 'nope'],
    ['missing projectId', sampleTask({ projectId: undefined })],
    ['empty requestId', sampleTask({ requestId: '  ' })],
  ])('rejects %s', (_label, raw) => {
    expect(validateTask(raw).ok).toBe(false)
  })
})

describe('TaskConsumer.consumeOne', () => {
  it('returns false on an empty queue', async () => {
    const { consumer } = setup()
    expect(await consumer.consumeOne()).toBe(false)
  })

  it('launches a session end-to-end for a valid task', async () => {
    const { host, cfg, consumer, tracker } = setup()
    await host.redis.rPush(cfg.queueKey, sampleTask())

    expect(await consumer.consumeOne()).toBe(true)
    expect(host.createCalls).toHaveLength(1)
    expect(host.followups).toHaveLength(1) // first prompt delivered
    expect(host.registeredSkills).toHaveLength(2) // both skillIds injected
    expect(tracker.running()).toBe(1) // counts toward the gate
    // claim held as processing; backup stays until the session settles
    expect(host.redis.peekString(`${cfg.idempotency.keyPrefix}:1234-abcd-5678-efgh`)).toBe('processing')
    expect(host.redis.peekList(cfg.processingKey)).toHaveLength(1)
    expect(host.redis.peekList(cfg.queueKey)).toEqual([]) // dequeued
  })

  it('dead-letters an invalid payload and acks its backup', async () => {
    const { host, cfg, consumer } = setup()
    await host.redis.rPush(cfg.queueKey, sampleTask({ projectId: undefined }))

    expect(await consumer.consumeOne()).toBe(true)
    expect(host.createCalls).toHaveLength(0)
    expect(host.redis.peekList(cfg.deadLetterKey)).toHaveLength(1)
    expect(host.redis.peekList(cfg.processingKey)).toEqual([])
  })

  it('skips a duplicate requestId without launching', async () => {
    const { host, cfg, consumer } = setup()
    await host.redis.setIfAbsent(`${cfg.idempotency.keyPrefix}:dup-1`, 'processing')
    await host.redis.rPush(cfg.queueKey, sampleTask({ requestId: 'dup-1' }))

    expect(await consumer.consumeOne()).toBe(true)
    expect(host.createCalls).toHaveLength(0)
    expect(host.logText('info')).toContain('duplicate')
    expect(host.redis.peekList(cfg.processingKey)).toEqual([]) // backup acked
  })

  it('requeues and releases the claim when the launch fails under the retry cap', async () => {
    const { host, cfg, consumer } = setup(
      { resolveCallConfig: async () => { throw new Error('no model route') } },
      { maxRetries: 3 },
    )
    await host.redis.rPush(cfg.queueKey, sampleTask({ requestId: 'fail-1' }))

    expect(await consumer.consumeOne()).toBe(true)
    expect(host.createCalls).toHaveLength(0)
    expect(host.redis.peekString(`${cfg.idempotency.keyPrefix}:fail-1`)).toBeUndefined() // released
    expect(host.redis.peekList(cfg.processingKey)).toEqual([]) // acked
    const requeued = host.redis.peekList(cfg.queueKey) as TaskPayload[]
    expect(requeued).toHaveLength(1)
    expect(requeued[0]?.__retries).toBe(1)
  })

  it('dead-letters a failing task once retries are exhausted', async () => {
    const { host, cfg, consumer } = setup(
      { resolveCallConfig: async () => { throw new Error('no model route') } },
      { maxRetries: 0 },
    )
    await host.redis.rPush(cfg.queueKey, sampleTask({ requestId: 'fail-2' }))

    expect(await consumer.consumeOne()).toBe(true)
    expect(host.redis.peekList(cfg.queueKey)).toEqual([]) // not requeued
    expect(host.redis.peekList(cfg.deadLetterKey)).toHaveLength(1)
  })

  it('acks the processing backup byte-for-byte even when validateTask reshapes the payload (D1)', async () => {
    // The raw payload has extra unknown fields, a missing taskName (which
    // validateTask defaults to projectId), and a different key order than the
    // normalized task. Under the redis plugin's `value: json` codec, `lRem`
    // only matches when the serialized bytes are identical — so this test
    // fails if handleFailure ever acks with the normalized task instead of
    // the original raw reference.
    const { host, cfg, consumer } = setup(
      { resolveCallConfig: async () => { throw new Error('no model route') } },
      { maxRetries: 0 }, // straight to DLQ; keeps the assertion surface small
    )
    const raw = {
      userCode: 'S9',
      taskName: undefined,
      sourceLang: 'zh',
      targetLang: 'en',
      projectId: 'P-D1',
      requestId: 'req-d1',
      platform: 'Chiao',
      skillIds: ['1', 42, '2'], // mixed types → filtered by validateTask
      extraProducerField: 'ignored-by-schema',
    }
    await host.redis.rPush(cfg.queueKey, raw)

    expect(await consumer.consumeOne()).toBe(true)
    // The critical assertion: the processing backup is empty, proving lRem
    // matched the raw bytes (not the normalized task's re-serialized form).
    expect(host.redis.peekList(cfg.processingKey)).toEqual([])
    expect(host.redis.peekList(cfg.deadLetterKey)).toHaveLength(1)
    expect(host.redis.peekList(cfg.queueKey)).toEqual([])
  })

  it('acks the processing backup on the duplicate-requestId path with the raw reference', async () => {
    const { host, cfg, consumer } = setup()
    await host.redis.setIfAbsent(`${cfg.idempotency.keyPrefix}:dup-raw`, 'processing')
    const raw = {
      // Deliberately odd key order + missing taskName so normalization would
      // produce different JSON bytes than the raw payload.
      requestId: 'dup-raw',
      projectId: 'P-DUP',
      skillIds: [],
      platform: 'Chiao',
      sourceLang: 'zh',
      targetLang: 'en',
      userCode: 'S1',
    }
    await host.redis.rPush(cfg.queueKey, raw)

    expect(await consumer.consumeOne()).toBe(true)
    expect(host.redis.peekList(cfg.processingKey)).toEqual([])
    expect(host.createCalls).toHaveLength(0)
  })
})
