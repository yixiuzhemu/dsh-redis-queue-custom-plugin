import { describe, expect, it } from 'vitest'
import { IdempotencyGuard } from '../src/idempotency.ts'
import { resolveConfig } from '../src/config.ts'
import { createTestHost } from './stubs/host.ts'

function setup() {
  const host = createTestHost()
  const cfg = resolveConfig({})
  const guard = new IdempotencyGuard(host.ctx, cfg)
  const key = (requestId: string) => `${cfg.idempotency.keyPrefix}:${requestId}`
  return { host, cfg, guard, key }
}

describe('IdempotencyGuard', () => {
  it('acquires a fresh requestId, then reports a duplicate on the second claim', async () => {
    const { guard, key, host } = setup()
    const first = await guard.claim('req-1')
    expect(first.state).toBe('acquired')
    expect(host.redis.peekString(key('req-1'))).toBe('processing')

    const second = await guard.claim('req-1')
    expect(second.state).toBe('duplicate')
    if (second.state === 'duplicate') expect(second.status).toBe('processing')
  })

  it('markDone overwrites with a done:{sessionId} marker that survives a later claim', async () => {
    const { guard, key, host } = setup()
    await guard.claim('req-2')
    await guard.markDone('req-2', 'sess-99')
    expect(host.redis.peekString(key('req-2'))).toBe('done:sess-99')

    const replay = await guard.claim('req-2')
    expect(replay.state).toBe('duplicate')
    if (replay.state === 'duplicate') expect(replay.status).toBe('done:sess-99')
  })

  it('release clears the claim so a requeued task can re-acquire it', async () => {
    const { guard, key, host } = setup()
    await guard.claim('req-3')
    await guard.release('req-3')
    expect(host.redis.peekString(key('req-3'))).toBeUndefined()
    expect((await guard.claim('req-3')).state).toBe('acquired')
  })
})
