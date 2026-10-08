import { describe, expect, it } from 'vitest'
import { SessionLauncher } from '../src/launcher.ts'
import { resolveConfig, type QueueConfig } from '../src/config.ts'
import type { TaskPayload } from '../src/types.ts'
import { createTestHost, type TestHostOptions } from './stubs/host.ts'

const task: TaskPayload = {
  platform: 'Chiao',
  projectId: 'P1',
  requestId: 'req-launch',
  skillIds: [],
  sourceLang: 'zh',
  targetLang: 'en',
  taskName: 't',
  userCode: 'S1',
}

function setup(opts: TestHostOptions = {}, cfgPatch: Partial<QueueConfig> = {}) {
  const host = createTestHost(opts)
  const cfg = resolveConfig({ workspaceRoot: '/tmp/dsh-rq-launcher', ...cfgPatch })
  const launcher = new SessionLauncher(host.ctx, cfg)
  return { host, cfg, launcher }
}

/** Let queued microtasks (async rejection handlers) run to completion. */
async function flush(): Promise<void> {
  for (let i = 0; i < 8; i++) await Promise.resolve()
}

describe('SessionLauncher.launch', () => {
  it('returns the session id and delivers one followup on the happy path', async () => {
    const { host, launcher } = setup()
    const id = await launcher.launch({ task, workspace: { id: 'ws-1', path: '/tmp/w' }, skillIds: [] })
    expect(typeof id).toBe('string')
    expect(id.length).toBeGreaterThan(0)
    expect(host.followups).toHaveLength(1)
    expect(host.disposeCalls).toHaveLength(0)
  })

  it('disposes the handle and rethrows when followup throws synchronously (D5)', async () => {
    const { host, launcher } = setup({
      followup: () => {
        throw new Error('sync followup failure')
      },
    })
    await expect(
      launcher.launch({ task, workspace: { id: 'ws-1', path: '/tmp/w' }, skillIds: [] }),
    ).rejects.toThrow(/sync followup failure/)
    // The freshly-created agent must not be leaked when the first delivery fails.
    expect(host.disposeCalls).toHaveLength(1)
  })

  it('catches an async followup rejection, logs, disposes, and does not surface an unhandled rejection (D5)', async () => {
    const { host, launcher } = setup({
      followup: () => Promise.reject(new Error('async followup failure')),
    })
    // The launcher itself resolves normally — the rejection is handled out-of-band.
    const id = await launcher.launch({ task, workspace: { id: 'ws-1', path: '/tmp/w' }, skillIds: [] })
    expect(id.length).toBeGreaterThan(0)
    await flush()
    expect(host.disposeCalls).toHaveLength(1)
    expect(host.logText('warn')).toContain('followup rejected')
    expect(host.logText('warn')).toContain('async followup failure')
  })

  it('attaches the new session to its workspace on the happy path', async () => {
    const { host, launcher } = setup({
      workspaces: [
        {
          id: 'ws-1',
          path: '/tmp/w',
          title: 'w',
          createdAt: '2026-01-01T00:00:00.000Z',
          updatedAt: '2026-01-01T00:00:00.000Z',
          sessionIds: [],
          async status() {
            return 'ok' as const
          },
          async attachSession() {},
        },
      ],
    })
    const id = await launcher.launch({ task, workspace: { id: 'ws-1', path: '/tmp/w' }, skillIds: [] })
    expect(host.attached.some((a) => a.workspaceId === 'ws-1' && String(a.sessionId) === id)).toBe(true)
  })
})
