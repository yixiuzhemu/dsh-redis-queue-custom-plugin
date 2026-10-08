import { describe, expect, it, vi } from 'vitest'
import { resolve as resolvePath } from 'node:path'
import { WorkspaceProvisioner } from '../src/workspace.ts'
import { resolveConfig } from '../src/config.ts'
import { createTestHost, type TestHost } from './stubs/host.ts'

// Keep provisioning side-effect free: the real `mkdir` is stubbed out.
vi.mock('node:fs/promises', () => ({ mkdir: vi.fn(async () => undefined) }))

const ROOT = '/tmp/dsh-rq-test'

function setup(host?: TestHost) {
  const h = host ?? createTestHost()
  const cfg = resolveConfig({ workspaceRoot: ROOT, lock: { retryCount: 3, retryIntervalMs: 1 } })
  const provisioner = new WorkspaceProvisioner(h.ctx, cfg)
  return { host: h, cfg, provisioner, target: (projectId: string) => resolvePath(ROOT, projectId) }
}

describe('WorkspaceProvisioner.ensure', () => {
  it('creates a workspace under the lock and releases it afterwards', async () => {
    const { host, provisioner, target } = setup()
    const ref = await provisioner.ensure('P1', 'title-1')

    expect(ref.path).toBe(target('P1'))
    expect(host.registry.createCount).toBe(1)
    // lock was taken on the slow path and fully released
    expect(host.redis.lockAcquireCount).toBe(1)
    expect(host.redis.heldLocks()).toEqual([])
    // projectId→workspaceId cache populated for the fast path
    expect(host.redis.peekString(`DSH:TASK:ws:P1`)).toBe(ref.id)
  })

  it('reuses an existing workspace matched by canonical path (no create)', async () => {
    const target = resolvePath(ROOT, 'P2')
    const host = createTestHost()
    // Pre-seed a workspace at the exact path the provisioner will look for.
    await host.registry.create(target, 'pre-existing')
    const before = host.registry.createCount

    const { provisioner } = setup(host)
    const ref = await provisioner.ensure('P2')

    expect(ref.path).toBe(target)
    expect(host.registry.createCount).toBe(before) // reused, not recreated
  })

  it('serves a warm cache hit without taking the lock again', async () => {
    const { host, provisioner } = setup()
    const first = await provisioner.ensure('P3')
    const locksAfterFirst = host.redis.lockAcquireCount
    const second = await provisioner.ensure('P3')

    expect(second.id).toBe(first.id)
    expect(host.redis.lockAcquireCount).toBe(locksAfterFirst) // fast path: no new lock
    expect(host.registry.createCount).toBe(1)
  })

  it('serializes concurrent provisioning of one projectId into a single create', async () => {
    const { host, provisioner } = setup()
    const [a, b] = await Promise.all([provisioner.ensure('P4'), provisioner.ensure('P4')])

    expect(a.id).toBe(b.id)
    expect(host.registry.createCount).toBe(1) // double-check inside the lock
    expect(host.redis.heldLocks()).toEqual([])
  })
})
