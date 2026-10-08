/**
 * Wire types for the queue payload plus internal vocabulary shared across the
 * consumer modules.
 *
 * @module dsh-redis-queue-custom-plugin/types
 */

/**
 * One element of the `DSH:TASK` queue. The producer `rPush`es this JSON; the
 * redis plugin's default `value: json` codec decodes it back to this shape on
 * `lPop<TaskPayload>()`.
 */
export interface TaskPayload {
  /** Reserved by the producer; carried through for audit only. */
  agentId?: string
  /** Platform name (e.g. "Chiao"); written into the prompt context / log tag. */
  platform: string
  /** Workspace id: existence check + distributed-lock key + directory name. */
  projectId: string
  /** Session id: the idempotency key so one task executes at most once. */
  requestId: string
  /** Requested skill ids (external catalog ids) resolved via Skills-Manager. */
  skillIds: string[]
  /** Source language. */
  sourceLang: string
  /** Target language. */
  targetLang: string
  /** Task name; used as the workspace title and prompt heading. */
  taskName: string
  /** User code that created the task; prompt context / audit. */
  userCode: string
  /**
   * Internal retry counter, transparently carried through a requeue. Not part of
   * the producer contract; stripped from logs and never required on input.
   */
  __retries?: number
}

/** A resolved workspace reference (id + canonical directory path). */
export interface WorkspaceRef {
  readonly id: string
  readonly path: string
}

/** Input to {@link SessionLauncher.launch}. */
export interface LaunchInput {
  readonly task: TaskPayload
  readonly workspace: WorkspaceRef
  /** Skill names resolved/filtered by {@link SkillResolver} (name-addressed keys). */
  readonly skillIds: string[]
}

/** Metadata the tracker keeps for an in-flight session so it can settle it. */
export interface TrackedMeta {
  readonly requestId: string
  /** The raw payload pushed to the processing backup list, for ack/requeue. */
  readonly backup: TaskPayload
  readonly task: TaskPayload
}

/** A tracked in-flight session (metadata + its launch instant). */
export interface TrackedSession extends TrackedMeta {
  readonly sessionId: string
  readonly startedAt: number
}

/** Schema-validation outcome for a dequeued payload. */
export type ValidateResult =
  | { readonly ok: true; readonly task: TaskPayload }
  | { readonly ok: false; readonly reason: string }

/** One environment sample taken before a consume attempt. */
export interface EnvSample {
  /** CPU utilization over the sampling window, 0..1. */
  readonly cpuUsageRatio: number
  /** System memory utilization, 0..1. */
  readonly memoryUsageRatio: number
  /** Sessions this plugin has launched and not yet settled. */
  readonly runningSessions: number
  /** True when every metric is within its threshold. */
  readonly allowed: boolean
  /** Human-readable reason when not allowed (log-only). */
  readonly reason?: string
}
