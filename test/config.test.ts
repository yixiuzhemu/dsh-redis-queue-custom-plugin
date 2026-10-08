import { describe, expect, it } from 'vitest'
import { assertConfig, defaultConfig, resolveConfig } from '../src/config.ts'

describe('resolveConfig', () => {
  it('returns deep defaults for an empty input', () => {
    const cfg = resolveConfig({})
    expect(cfg.queueKey).toBe('DSH:TASK')
    expect(cfg.pollIntervalMs).toBe(15_000)
    expect(cfg.thresholds.maxConcurrentSessions).toBe(defaultConfig.thresholds.maxConcurrentSessions)
    expect(cfg.idempotency.keyPrefix).toBe('DSH:TASK:req')
  })

  it('deep-merges nested sections without dropping sibling defaults', () => {
    const cfg = resolveConfig({
      queueKey: 'CUSTOM:Q',
      thresholds: { maxConcurrentSessions: 5 },
      idempotency: { doneTtlMs: 1000 },
    })
    expect(cfg.queueKey).toBe('CUSTOM:Q')
    // overridden
    expect(cfg.thresholds.maxConcurrentSessions).toBe(5)
    expect(cfg.idempotency.doneTtlMs).toBe(1000)
    // preserved siblings
    expect(cfg.thresholds.maxCpuUsageRatio).toBe(defaultConfig.thresholds.maxCpuUsageRatio)
    expect(cfg.idempotency.keyPrefix).toBe(defaultConfig.idempotency.keyPrefix)
  })

  it('ignores undefined values so patch layers compose over defaults', () => {
    const cfg = resolveConfig({ queueKey: undefined, batchSize: undefined })
    expect(cfg.queueKey).toBe(defaultConfig.queueKey)
    expect(cfg.batchSize).toBe(defaultConfig.batchSize)
  })
})

describe('assertConfig', () => {
  it('accepts the resolved defaults', () => {
    expect(() => assertConfig(resolveConfig({}))).not.toThrow()
  })

  it.each([
    ['empty queueKey', { queueKey: '  ' }],
    ['pollIntervalMs too small', { pollIntervalMs: 500 }],
    ['batchSize < 1', { batchSize: 0 }],
    ['cpu ratio out of range', { thresholds: { maxCpuUsageRatio: 1.5 } }],
    ['memory ratio out of range', { thresholds: { maxMemoryUsageRatio: 0 } }],
    ['maxConcurrentSessions < 1', { thresholds: { maxConcurrentSessions: 0 } }],
  ])('rejects %s', (_label, patch) => {
    expect(() => assertConfig(resolveConfig(patch as any))).toThrow(/redis-queue:/)
  })
})
