/**
 * In-memory `FakeRedis`: implements the subset of the dsh-redis-plugin
 * `RedisService` surface the queue consumer uses (list / string / lock), with a
 * real per-key mutex so distributed-lock mutual exclusion can be asserted
 * offline.
 */

import type { LockToken, RedisService, TimeUnit, WithLockOptions } from 'dsh-redis-plugin'

/**
 * Byte-identical JSON encoding, mirroring the real dsh-redis-plugin's
 * `value: json` codec. Deliberately does NOT sort keys: `lRem` on a list of
 * JSON-encoded payloads only matches when the serialized bytes are equal, so
 * tests must exercise the same key order the producer/consumer paths use.
 */
function ser(value: unknown): string {
  return JSON.stringify(value) ?? 'null'
}

export class FakeRedis implements RedisService {
  private readonly strings = new Map<string, unknown>()
  private readonly lists = new Map<string, unknown[]>()
  private readonly chains = new Map<string, Promise<unknown>>()
  private readonly held = new Set<string>()

  /** Total lock acquisitions (asserts the slow path actually took the lock). */
  lockAcquireCount = 0

  readonly lock = (() => {
    const self = this
    return {
      withLock<T>(key: string, fn: () => Promise<T>, _opts?: WithLockOptions): Promise<T> {
        return self.withLock(key, fn)
      },
      async tryLock(_key: string, _ttl?: number, _unit?: TimeUnit): Promise<LockToken | null> {
        return null
      },
      async unlock(_key: string, _token: LockToken): Promise<boolean> {
        return true
      },
      get heldCount(): number {
        return self.held.size
      },
    }
  })()

  // ── string ──────────────────────────────────────────────────────────────
  async get<T>(key: string): Promise<T | null> {
    return this.strings.has(key) ? (this.strings.get(key) as T) : null
  }

  async set(key: string, value: unknown, opts?: { nx?: boolean }): Promise<'OK' | null> {
    if (opts?.nx && this.strings.has(key)) return null
    this.strings.set(key, value)
    return 'OK'
  }

  async setEx(key: string, value: unknown, _ttl: number, _unit?: TimeUnit): Promise<void> {
    this.strings.set(key, value)
  }

  async setIfAbsent(key: string, value: unknown, _ttl?: number, _unit?: TimeUnit): Promise<boolean> {
    if (this.strings.has(key)) return false
    this.strings.set(key, value)
    return true
  }

  // ── key ─────────────────────────────────────────────────────────────────
  async del(key: string | string[]): Promise<number> {
    const keys = Array.isArray(key) ? key : [key]
    let n = 0
    for (const k of keys) {
      if (this.strings.delete(k)) n++
      if (this.lists.delete(k)) n++
    }
    return n
  }

  async exists(key: string): Promise<boolean> {
    return this.strings.has(key) || this.lists.has(key)
  }

  // ── list ────────────────────────────────────────────────────────────────
  async lPush(key: string, ...values: unknown[]): Promise<number> {
    const l = this.list(key)
    l.unshift(...values)
    return l.length
  }

  async rPush(key: string, ...values: unknown[]): Promise<number> {
    const l = this.list(key)
    l.push(...values)
    return l.length
  }

  async lPop<T>(key: string): Promise<T | null> {
    const l = this.list(key)
    return l.length > 0 ? (l.shift() as T) : null
  }

  async rPop<T>(key: string): Promise<T | null> {
    const l = this.list(key)
    return l.length > 0 ? (l.pop() as T) : null
  }

  async lLen(key: string): Promise<number> {
    return this.list(key).length
  }

  async lRem(key: string, count: number, value: unknown): Promise<number> {
    const l = this.list(key)
    const target = ser(value)
    const limit = count === 0 ? Infinity : Math.abs(count)
    let removed = 0
    for (let i = 0; i < l.length && removed < limit; ) {
      if (ser(l[i]) === target) {
        l.splice(i, 1)
        removed++
      } else {
        i++
      }
    }
    return removed
  }

  async brPop<T>(key: string, _timeoutSec?: number): Promise<[string, T] | null> {
    const v = await this.rPop<T>(key)
    return v === null ? null : [key, v]
  }

  async blPop<T>(key: string, _timeoutSec?: number): Promise<[string, T] | null> {
    const v = await this.lPop<T>(key)
    return v === null ? null : [key, v]
  }

  // ── helpers ─────────────────────────────────────────────────────────────
  private list(key: string): unknown[] {
    let l = this.lists.get(key)
    if (l === undefined) {
      l = []
      this.lists.set(key, l)
    }
    return l
  }

  /** Serialize critical sections per key; mirrors `withLock`'s release-in-finally. */
  private async withLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
    this.lockAcquireCount++
    const prev = this.chains.get(key) ?? Promise.resolve()
    const current = prev.then(async () => {
      this.held.add(key)
      try {
        return await fn()
      } finally {
        this.held.delete(key)
      }
    })
    // Swallow for the chain so a failure does not wedge later acquirers.
    this.chains.set(key, current.catch(() => undefined))
    return current
  }

  /** Test introspection. */
  peekString(key: string): unknown {
    return this.strings.get(key)
  }

  peekList(key: string): unknown[] {
    return (this.lists.get(key) ?? []).slice()
  }

  /** Locks currently held (empty once every `withLock` section has released). */
  heldLocks(): string[] {
    return [...this.held]
  }

  /** Expose the index signature the ambient `RedisService` type requires. */
  [key: string]: any
}
