/**
 * Ambient type shims for the DeepSeek Harness (dsh) SDK packages and the
 * sibling `dsh-redis-plugin`.
 *
 * These packages are *deploy-time peers*: the dsh host provides them when this
 * bundle is loaded into a profile, and `dsh-redis-plugin` provides `ctx.redis`.
 * They are NOT installed here, so the declarations below describe only the
 * surface this plugin consumes, allowing the project to type-check and build
 * standalone (mirrors the shim strategy of `dsh-redis-plugin` and `Remote-Task`).
 *
 * NOTE: When developing inside a real dsh monorepo (where the genuine packages
 * are linked), delete this file so the real SDK types take precedence.
 */

declare module '@deepseek-ai/cordis' {
  /** Disposable handle returned by reversible registrations. */
  export type Disposer = () => void | Promise<void>

  export interface Logger {
    debug(...args: unknown[]): void
    info(...args: unknown[]): void
    warn(...args: unknown[]): void
    error(...args: unknown[]): void
  }

  /** Cordis event map; augmentable by plugins. Left permissive here. */
  export interface Events {
    [event: string]: (...args: any[]) => any
  }

  /**
   * Minimal structural view of the Cordis context used by this plugin. The host
   * services (`agents`, `llm`, `skills`, `sessions`, `workspaceRegistry`) and
   * `redis` are reachable through the index signature / the augmentation below;
   * concrete shapes come from the real SDK at deploy time.
   */
  export interface Context {
    logger: Logger
    /** Provide a service onto a stable context key for other plugins to inject. */
    provide<T>(key: string, value: T): Disposer
    /** Read a service from the global registry (optional dependency). */
    get<T = unknown>(key: string): T | undefined
    /** Register a reversible effect; the returned disposer runs on unload/HMR. */
    effect(setup: () => void | Disposer | Promise<void | Disposer>, name?: string): Disposer
    /** Register a reversible event listener. */
    on(event: string, listener: (...args: any[]) => any): Disposer
    /** Redis facade provided by dsh-redis-plugin (see the augmentation below). */
    redis: import('dsh-redis-plugin').RedisService
    /** Host services consumed by this plugin; typed loosely by the shim. */
    agents: any
    llm: any
    skills: any
    sessions: any
    workspaceRegistry: any
    [key: string]: any
  }

  /** Base class for services exposed on `ctx.<key>`. */
  export class Service {
    constructor(ctx: Context, key: string)
    ctx: Context
  }
}

declare module '@deepseek-ai/schemastery' {
  /** Permissive, chainable schema builder mirroring the schemastery API. */
  export interface Schema {
    required(): Schema
    optional(): Schema
    default(value: unknown): Schema
    description(text: string): Schema
    role(role: string): Schema
    min(n: number): Schema
    max(n: number): Schema
    step(n: number): Schema
    [key: string]: any
  }
  export interface SchemaConstructor {
    any(): Schema
    string(): Schema
    number(): Schema
    boolean(): Schema
    literal(value: unknown): Schema
    array(item: Schema): Schema
    object(shape: Record<string, Schema>): Schema
    union(options: Schema[]): Schema
    record(value: Schema): Schema
    enum(values: unknown[]): Schema
    intersect(a: Schema, b: Schema): Schema
    [key: string]: any
  }
  const z: SchemaConstructor
  export default z
}

declare module '@deepseek-ai/dsh-brand' {
  /** Brand a plain string with a phantom type (e.g. SessionId). */
  export function brandString<T>(value: string): T
}

declare module '@deepseek-ai/dsh-llm' {
  export interface ContentBlock {
    type: string
    text?: string
    [key: string]: unknown
  }
  export interface UserMessage {
    id?: string
    content: ContentBlock[]
    source: { kind: string; plugin?: string; [key: string]: unknown }
    [key: string]: unknown
  }
  export interface LlmCallConfig {
    provider: string
    model: string
    reasoningEffort?: unknown
    maxTokens?: number
    [key: string]: unknown
  }
  export function createUserMessage(input: {
    content: ContentBlock[]
    source: { kind: string; plugin?: string; [key: string]: unknown }
  }): UserMessage
  /** Flatten an unknown thrown value into a readable diagnostic chain. */
  export function errorChain(error: unknown): string
  /** Coerce a reasoning-effort string into the harness id type. */
  export function ReasoningEffortId(value: string): unknown
}

declare module '@deepseek-ai/dsh-agent' {
  export type AgentStatus = 'idle' | 'running'
  export interface Agent {
    session: { id: string; [key: string]: unknown }
    status?: AgentStatus
    followup(message: unknown): void
    inject?(message: unknown): void
    cancel(cause: unknown, opts?: { keepInbox?: boolean }): void
    whenIdle(): Promise<void>
    [key: string]: any
  }
  export interface AgentHandle {
    agent: Agent
    dispose(): Promise<void>
    [key: string]: any
  }
}

declare module '@deepseek-ai/dsh-session' {
  /** Branded session identifier. */
  export type SessionId = string & { readonly __brand?: 'SessionId' }
  export interface TurnEndReason {
    kind: string
    [key: string]: unknown
  }
  export interface SessionEvent {
    type: string
    time?: number
    data?: any
    [key: string]: any
  }
}

declare module '@deepseek-ai/dsh-skill' {
  export interface SkillDefinition {
    name: string
    description: string
    content?: string
    source?: unknown
    whenToUse?: string
    resourceBase?: unknown
    [key: string]: unknown
  }
}

declare module '@deepseek-ai/dsh-workspace' {
  export type WorkspaceId = string & { readonly __brand?: 'WorkspaceId' }
  export interface Workspace {
    id: WorkspaceId
    path: string
    title: string
    createdAt: string
    updatedAt: string
    sessionIds: ReadonlySet<string> | string[]
    status(): Promise<'ok' | 'missing-dir'>
    attachSession(sessionId: unknown): Promise<void>
    [key: string]: any
  }
  export interface WorkspaceRegistry {
    list(): Workspace[]
    get(id: WorkspaceId | string): Workspace | undefined
    create(path: string, title?: string): Promise<Workspace>
    delete(id: WorkspaceId | string): Promise<boolean>
    [key: string]: any
  }
}

/**
 * The Redis facade this plugin consumes. Only the operations used by the queue
 * consumer are declared; the genuine `dsh-redis-plugin` surface is far larger.
 * The `Context.redis` augmentation lives in the cordis module above.
 */
declare module 'dsh-redis-plugin' {
  export type TimeUnit = 'ms' | 's' | 'm' | 'h' | 'd'
  export interface LockToken {
    readonly key: string
    readonly value: string
    readonly ttlMs: number
    readonly acquiredAt: number
  }
  export interface WithLockOptions {
    ttl?: number
    unit?: TimeUnit
    retryInterval?: number
    retryCount?: number
    onLost?: (key: string) => void
  }
  export interface RedisLock {
    tryLock(key: string, ttl?: number, unit?: TimeUnit): Promise<LockToken | null>
    unlock(key: string, token: LockToken): Promise<boolean>
    withLock<T>(key: string, fn: () => Promise<T>, opts?: WithLockOptions): Promise<T>
    readonly heldCount: number
  }
  export interface RedisService {
    readonly lock: RedisLock
    // string
    get<T>(key: string): Promise<T | null>
    set(key: string, value: unknown, opts?: { ex?: number; px?: number; nx?: boolean; xx?: boolean }): Promise<'OK' | null>
    setEx(key: string, value: unknown, ttl: number, unit?: TimeUnit): Promise<void>
    setIfAbsent(key: string, value: unknown, ttl?: number, unit?: TimeUnit): Promise<boolean>
    // key
    del(key: string | string[]): Promise<number>
    exists(key: string): Promise<boolean>
    // list
    lPush(key: string, ...values: unknown[]): Promise<number>
    rPush(key: string, ...values: unknown[]): Promise<number>
    lPop<T>(key: string): Promise<T | null>
    rPop<T>(key: string): Promise<T | null>
    lLen(key: string): Promise<number>
    lRem(key: string, count: number, value: unknown): Promise<number>
    brPop<T>(key: string, timeoutSec?: number): Promise<[string, T] | null>
    blPop<T>(key: string, timeoutSec?: number): Promise<[string, T] | null>
    [key: string]: any
  }
}
