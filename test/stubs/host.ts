/**
 * Offline host double: fabricates a fake Cordis `Context` carrying the host
 * services this plugin injects (`redis`, `agents`, `llm`, `skills`,
 * `workspaceRegistry`) plus an optional `skillsManager`, with spies and an
 * `emit()` helper so event-driven code (tracker) can be exercised offline.
 */

import { FakeRedis } from './fake-redis.ts'

export interface LogEntry {
  readonly level: 'debug' | 'info' | 'warn' | 'error'
  readonly args: unknown[]
}

export interface SkillRecordLike {
  id?: string
  name?: string
}

export interface SkillsManagerLike {
  resolveSkillById(id: string): Promise<SkillRecordLike | undefined>
}

export interface FakeWorkspace {
  id: string
  path: string
  title: string
  createdAt: string
  updatedAt: string
  sessionIds: string[]
  status(): Promise<'ok' | 'missing-dir'>
  attachSession(sessionId: unknown): Promise<void>
}

export interface TestHostOptions {
  readonly redis?: FakeRedis
  readonly skillsManager?: SkillsManagerLike
  /** Skill defs returned by `ctx.skills.get(name)` (name-addressed registry). */
  readonly knownSkills?: Record<string, { name: string; description: string }>
  /** Pre-seeded workspaces in the registry (path-matched by the provisioner). */
  readonly workspaces?: FakeWorkspace[]
  /** Override `ctx.llm.resolveCallConfig`; rejects to force a launch failure. */
  readonly resolveCallConfig?: (draft: unknown) => Promise<unknown>
  /**
   * When true, `ctx.get(key)` throws for unregistered services, mirroring real
   * Cordis behavior. Defaults to true so the plugin's optional-injection paths
   * are exercised honestly; tests that rely on the permissive stub can opt out.
   */
  readonly getThrowsOnMissing?: boolean
  /**
   * Override `agent.followup`. Return a rejected promise to exercise the
   * launcher's async-rejection path, or throw synchronously for the sync path.
   */
  readonly followup?: (message: unknown) => unknown
  /** Override `handle.dispose`; used to assert cleanup after a failed launch. */
  readonly dispose?: () => unknown
}

export interface TestHost {
  readonly ctx: any
  readonly redis: FakeRedis
  readonly logs: LogEntry[]
  readonly registry: {
    list(): FakeWorkspace[]
    get(id: string): FakeWorkspace | undefined
    create(path: string, title?: string): Promise<FakeWorkspace>
    readonly createCount: number
    readonly items: FakeWorkspace[]
  }
  readonly createCalls: any[]
  readonly followups: any[]
  readonly disposeCalls: number[]
  readonly registeredSkills: any[]
  readonly attached: Array<{ workspaceId: string; sessionId: unknown }>
  emit(event: string, ...args: unknown[]): void
  logText(level: LogEntry['level']): string
}

function makeWorkspace(id: string, path: string, title: string): FakeWorkspace {
  return {
    id,
    path,
    title,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    sessionIds: [],
    async status() {
      return 'ok'
    },
    async attachSession(sessionId: unknown) {
      this.sessionIds.push(String(sessionId))
    },
  }
}

export function createTestHost(opts: TestHostOptions = {}): TestHost {
  const redis = opts.redis ?? new FakeRedis()
  const logs: LogEntry[] = []
  const logger = {
    debug: (...args: unknown[]) => logs.push({ level: 'debug', args }),
    info: (...args: unknown[]) => logs.push({ level: 'info', args }),
    warn: (...args: unknown[]) => logs.push({ level: 'warn', args }),
    error: (...args: unknown[]) => logs.push({ level: 'error', args }),
  }

  const services = new Map<string, unknown>()
  if (opts.skillsManager !== undefined) services.set('skillsManager', opts.skillsManager)
  const getThrowsOnMissing = opts.getThrowsOnMissing ?? true

  const listeners = new Map<string, Set<(...args: unknown[]) => unknown>>()

  // ── workspace registry ────────────────────────────────────────────────
  const items: FakeWorkspace[] = [...(opts.workspaces ?? [])]
  let seq = items.length
  let createCount = 0
  const registry = {
    list: () => items.slice(),
    get: (id: string) => items.find((w) => String(w.id) === String(id)),
    async create(path: string, title?: string): Promise<FakeWorkspace> {
      createCount++
      const ws = makeWorkspace(`ws-${++seq}`, path, title ?? path)
      items.push(ws)
      return ws
    },
    get createCount() {
      return createCount
    },
    items,
  }

  // ── agents ────────────────────────────────────────────────────────────
  const createCalls: any[] = []
  const followups: any[] = []
  const disposeCalls: number[] = []
  const registeredSkills: any[] = []
  const agentCtx = {
    logger,
    skills: {
      register: (def: unknown) => registeredSkills.push(def),
    },
  }
  const agents = {
    async create(o: any) {
      createCalls.push(o)
      const agent = {
        session: { id: o.sessionId },
        followup: (m: unknown) => {
          followups.push(m)
          return opts.followup ? opts.followup(m) : undefined
        },
        cancel() {},
        async whenIdle() {},
      }
      if (typeof o.setup === 'function') await o.setup(agentCtx, agent)
      return {
        agent,
        async dispose() {
          disposeCalls.push(Date.now())
          if (opts.dispose) await opts.dispose()
        },
      }
    },
  }

  // ── llm / skills ──────────────────────────────────────────────────────
  const llm = {
    resolveCallConfig: opts.resolveCallConfig ?? (async (d: unknown) => d),
  }
  const knownSkills = opts.knownSkills ?? {}
  const skills = {
    async get(id: string) {
      return knownSkills[id]
    },
  }

  const attached: Array<{ workspaceId: string; sessionId: unknown }> = []
  const workspaceRegistry = {
    list: registry.list,
    get: (id: string) => {
      const ws = registry.get(id)
      if (ws === undefined) return undefined
      return {
        ...ws,
        attachSession: async (sessionId: unknown) => {
          attached.push({ workspaceId: id, sessionId })
          await ws.attachSession(sessionId)
        },
      }
    },
    create: registry.create,
  }

  const ctx: any = {
    logger,
    redis,
    agents,
    llm,
    skills,
    sessions: {},
    workspaceRegistry,
    get: (key: string) => {
      if (services.has(key)) return services.get(key)
      if (getThrowsOnMissing) throw new Error(`service not found: ${key}`)
      return undefined
    },
    provide: (key: string, value: unknown) => {
      services.set(key, value)
      return () => services.delete(key)
    },
    effect: (setup: () => unknown) => {
      const disposer = setup()
      return typeof disposer === 'function' ? disposer : () => {}
    },
    on: (event: string, fn: (...args: unknown[]) => unknown) => {
      let set = listeners.get(event)
      if (set === undefined) {
        set = new Set()
        listeners.set(event, set)
      }
      set.add(fn)
      return () => set!.delete(fn)
    },
  }

  function emit(event: string, ...args: unknown[]): void {
    const set = listeners.get(event)
    if (set !== undefined) for (const fn of [...set]) fn(...args)
  }

  function logText(level: LogEntry['level']): string {
    return logs
      .filter((l) => l.level === level)
      .map((l) => l.args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' '))
      .join('\n')
  }

  return { ctx, redis, logs, registry, createCalls, followups, disposeCalls, registeredSkills, attached, emit, logText }
}

/** A well-formed task matching the producer schema. */
export function sampleTask(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    agentId: '',
    platform: 'Chiao',
    projectId: 'D25081438501',
    requestId: '1234-abcd-5678-efgh',
    skillIds: ['1', '2'],
    sourceLang: 'zh',
    targetLang: 'en',
    taskName: '项目D25081438501的翻译任务',
    userCode: 'S00182',
    ...overrides,
  }
}
