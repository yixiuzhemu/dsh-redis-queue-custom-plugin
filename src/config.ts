/**
 * Plugin configuration schema (schemastery) + a framework-agnostic
 * {@link resolveConfig} deep-merge and {@link assertConfig} invariant check.
 *
 * @module dsh-redis-queue-custom-plugin/config
 */

import z from '@deepseek-ai/schemastery'

/** Consume strategy: non-blocking pop per tick, or a short blocking pop. */
export type ConsumeMode = 'poll' | 'blocking'

/** Idempotency key/TTL settings. */
export interface IdempotencyConfig {
  /** Prefix for the `SET NX` claim key (`{prefix}:{requestId}`). */
  keyPrefix: string
  /** TTL of the in-flight `processing` claim (short; auto-releases on crash). */
  processingTtlMs: number
  /** TTL of the terminal `done` claim (long; guards against replay). */
  doneTtlMs: number
}

/** Distributed-lock settings for workspace provisioning. */
export interface LockConfig {
  /** Prefix for the workspace lock key (`{prefix}:{projectId}`). */
  keyPrefix: string
  /** Lock TTL; the redis plugin's watchdog renews it during the critical section. */
  ttlMs: number
  /** Max acquisition retries when the lock is contended. */
  retryCount: number
  /** Interval between acquisition retries. */
  retryIntervalMs: number
  /** TTL of the projectId→workspaceId cache (lock-free fast path). */
  wsCacheTtlMs: number
}

/** Environment admission thresholds. */
export interface ThresholdConfig {
  /** Max CPU utilization ratio (0..1) allowed to consume. */
  maxCpuUsageRatio: number
  /** Max system memory utilization ratio (0..1) allowed to consume. */
  maxMemoryUsageRatio: number
  /** Max in-flight sessions launched by this plugin. */
  maxConcurrentSessions: number
  /** CPU sampling window; shorter is more reactive but noisier. */
  cpuSampleWindowMs: number
}

/** Resolved plugin configuration. */
export interface QueueConfig {
  /** Master switch; false disables the consumer entirely. */
  enabled: boolean
  /** Queue key to consume. */
  queueKey: string
  /** Dead-letter list key for poison/unrecoverable messages. */
  deadLetterKey: string
  /** Processing-backup list key for crash recovery. */
  processingKey: string

  /** Scheduler poll interval. */
  pollIntervalMs: number
  /** Non-blocking pop vs short blocking pop. */
  consumeMode: ConsumeMode
  /** Blocking pop timeout (consumeMode=blocking). */
  blockingTimeoutSec: number
  /** true: lPop (pairs with an rPush producer) for FIFO. */
  fifo: boolean
  /** Max tasks consumed per tick. */
  batchSize: number

  /** Base directory workspaces are created under; empty → ~/.dsh/redis-queue/workspaces. */
  workspaceRoot: string
  /** Default LLM provider when the task does not route a model. */
  defaultProvider: string
  /** Default model name. */
  defaultModel: string
  /** Optional prompt template override (supports {field} placeholders). */
  promptTemplate: string

  /** Re-queue a recoverable failure instead of dropping it. */
  requeueOnFailure: boolean
  /** Max requeue attempts before the task is sent to the DLQ. */
  maxRetries: number

  /**
   * Upper bound on how long a tracked session may stay in-flight before the
   * tracker stops counting it toward the concurrency gate. Guards against a
   * lost `turn/end` / `agent/error` event permanently wedging the gate.
   * The idempotency claim and processing backup are deliberately NOT touched
   * by the sweep (the session may still complete elsewhere); the claim's own
   * `processingTtlMs` bounds the duplicate-execution window.
   */
  sessionMaxLifetimeMs: number
  /** How often the tracker sweeps for stuck sessions. */
  sessionSweepIntervalMs: number

  idempotency: IdempotencyConfig
  lock: LockConfig
  thresholds: ThresholdConfig
}

/** Deep defaults so a bare `- name: dsh-redis-queue-custom-plugin` line works. */
export const defaultConfig: QueueConfig = {
  enabled: true,
  queueKey: 'DSH:TASK',
  deadLetterKey: 'DSH:TASK:DLQ',
  processingKey: 'DSH:TASK:processing',
  pollIntervalMs: 15_000,
  consumeMode: 'poll',
  blockingTimeoutSec: 5,
  fifo: true,
  batchSize: 1,
  workspaceRoot: '',
  defaultProvider: 'aliai',
  defaultModel: 'qwen3.8-flash',
  promptTemplate: '',
  requeueOnFailure: true,
  maxRetries: 3,
  sessionMaxLifetimeMs: 1_800_000,
  sessionSweepIntervalMs: 60_000,
  idempotency: {
    keyPrefix: 'DSH:TASK:req',
    processingTtlMs: 3_600_000,
    doneTtlMs: 604_800_000,
  },
  lock: {
    keyPrefix: 'DSH:TASK:lock:ws',
    ttlMs: 30_000,
    retryCount: 50,
    retryIntervalMs: 200,
    wsCacheTtlMs: 86_400_000,
  },
  thresholds: {
    maxCpuUsageRatio: 0.85,
    maxMemoryUsageRatio: 0.9,
    maxConcurrentSessions: 3,
    cpuSampleWindowMs: 1_000,
  },
}

export type DeepPartial<T> = { [K in keyof T]?: T[K] extends object ? DeepPartial<T[K]> : T[K] }

/** Strip `undefined` values so patch layers compose cleanly over defaults. */
function compact<T extends object>(obj?: T): Partial<T> {
  if (!obj) return {}
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(obj)) {
    if (v !== undefined) out[k] = v
  }
  return out as Partial<T>
}

/**
 * Merge a partial (possibly deeply nested) user config over {@link defaultConfig}.
 * `undefined` values are ignored so `cordis.patch.yml` layers compose.
 */
export function resolveConfig(input: DeepPartial<QueueConfig> = {}): QueueConfig {
  return {
    ...defaultConfig,
    ...compact(input),
    idempotency: { ...defaultConfig.idempotency, ...compact(input.idempotency) },
    lock: { ...defaultConfig.lock, ...compact(input.lock) },
    thresholds: { ...defaultConfig.thresholds, ...compact(input.thresholds) },
  }
}

/**
 * Validate config invariants Schemastery cannot express.
 * @param config - resolved configuration.
 * @throws {Error} when a numeric bound or key is invalid.
 */
export function assertConfig(config: QueueConfig): void {
  if (config.queueKey.trim() === '') {
    throw new Error('redis-queue: queueKey must be a non-empty string')
  }
  if (config.pollIntervalMs < 1000) {
    throw new Error('redis-queue: pollIntervalMs must be >= 1000')
  }
  if (config.batchSize < 1) {
    throw new Error('redis-queue: batchSize must be >= 1')
  }
  const t = config.thresholds
  if (t.maxCpuUsageRatio <= 0 || t.maxCpuUsageRatio > 1) {
    throw new Error('redis-queue: thresholds.maxCpuUsageRatio must be in (0, 1]')
  }
  if (t.maxMemoryUsageRatio <= 0 || t.maxMemoryUsageRatio > 1) {
    throw new Error('redis-queue: thresholds.maxMemoryUsageRatio must be in (0, 1]')
  }
  if (t.maxConcurrentSessions < 1) {
    throw new Error('redis-queue: thresholds.maxConcurrentSessions must be >= 1')
  }
  if (config.sessionMaxLifetimeMs < 1000) {
    throw new Error('redis-queue: sessionMaxLifetimeMs must be >= 1000')
  }
  if (config.sessionSweepIntervalMs < 1000) {
    throw new Error('redis-queue: sessionSweepIntervalMs must be >= 1000')
  }
}

/**
 * Deployment-time schema (schemastery). Loaded by the Cordis loader to validate
 * the `config:` block of this plugin's line in `cordis.patch.yml`.
 */
export const Config = z.object({
  enabled: z.boolean().default(defaultConfig.enabled),
  queueKey: z.string().default(defaultConfig.queueKey),
  deadLetterKey: z.string().default(defaultConfig.deadLetterKey),
  processingKey: z.string().default(defaultConfig.processingKey),

  pollIntervalMs: z.number().step(1).min(1000).default(defaultConfig.pollIntervalMs),
  consumeMode: z.union([z.const('poll'), z.const('blocking')]).default(defaultConfig.consumeMode),
  blockingTimeoutSec: z.number().default(defaultConfig.blockingTimeoutSec),
  fifo: z.boolean().default(defaultConfig.fifo),
  batchSize: z.number().step(1).min(1).default(defaultConfig.batchSize),

  workspaceRoot: z.string().default(defaultConfig.workspaceRoot),
  defaultProvider: z.string().default(defaultConfig.defaultProvider),
  defaultModel: z.string().default(defaultConfig.defaultModel),
  promptTemplate: z.string().default(defaultConfig.promptTemplate),

  requeueOnFailure: z.boolean().default(defaultConfig.requeueOnFailure),
  maxRetries: z.number().step(1).min(0).default(defaultConfig.maxRetries),

  sessionMaxLifetimeMs: z.number().min(1000).default(defaultConfig.sessionMaxLifetimeMs),
  sessionSweepIntervalMs: z.number().min(1000).default(defaultConfig.sessionSweepIntervalMs),

  idempotency: z
    .object({
      keyPrefix: z.string().default(defaultConfig.idempotency.keyPrefix),
      processingTtlMs: z.number().default(defaultConfig.idempotency.processingTtlMs),
      doneTtlMs: z.number().default(defaultConfig.idempotency.doneTtlMs),
    })
    .default({}),

  lock: z
    .object({
      keyPrefix: z.string().default(defaultConfig.lock.keyPrefix),
      ttlMs: z.number().default(defaultConfig.lock.ttlMs),
      retryCount: z.number().default(defaultConfig.lock.retryCount),
      retryIntervalMs: z.number().default(defaultConfig.lock.retryIntervalMs),
      wsCacheTtlMs: z.number().default(defaultConfig.lock.wsCacheTtlMs),
    })
    .default({}),

  thresholds: z
    .object({
      maxCpuUsageRatio: z.number().default(defaultConfig.thresholds.maxCpuUsageRatio),
      maxMemoryUsageRatio: z.number().default(defaultConfig.thresholds.maxMemoryUsageRatio),
      maxConcurrentSessions: z.number().step(1).default(defaultConfig.thresholds.maxConcurrentSessions),
      cpuSampleWindowMs: z.number().default(defaultConfig.thresholds.cpuSampleWindowMs),
    })
    .default({}),
})
