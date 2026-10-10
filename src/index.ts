/**
 * dsh-redis-queue-custom-plugin: an environment-gated Redis queue consumer for
 * deepseek-harness (dsh).
 *
 * Every `pollIntervalMs` (default 15s) it samples CPU / memory / running-session
 * count; when all are within thresholds it dequeues one task from `DSH:TASK` and
 * drives it through idempotency → locked workspace provisioning → Skills-Manager
 * resolution → session launch. Redis comes from `dsh-redis-plugin`; workspace /
 * agent / skill primitives are the same host services Remote-Task uses.
 *
 * @module dsh-redis-queue-custom-plugin
 */

import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-brand'
import type {} from '@deepseek-ai/dsh-llm'
import type {} from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-skill'
import type {} from '@deepseek-ai/dsh-workspace'
import type {} from 'dsh-redis-plugin'
import { Config, assertConfig, resolveConfig, type QueueConfig } from './config.ts'
import { QueueStore } from './queue.ts'
import { IdempotencyGuard } from './idempotency.ts'
import { WorkspaceProvisioner } from './workspace.ts'
import { SkillResolver } from './skills.ts'
import { SessionLauncher } from './launcher.ts'
import { ActiveSessionTracker } from './tracker.ts'
import { EnvironmentMonitor } from './monitor.ts'
import { TaskConsumer } from './consumer.ts'
import { Scheduler } from './scheduler.ts'

/** Cordis function-plugin name. */
export const name = 'redis-queue-consumer'

/**
 * Host services required before consuming. `redis` is provided by
 * dsh-redis-plugin; the rest are web-profile host services. `skillsManager`
 * (Skills-Manager) is read optionally via `ctx.get` so this plugin still loads
 * when Skills-Manager is absent.
 */
export const inject = ['redis', 'agents', 'llm', 'sessions', 'skills', 'workspaceRegistry']

export { Config }
export type { QueueConfig }
export type { TaskPayload, EnvSample, WorkspaceRef } from './types.ts'

/**
 * Wire the consumer pipeline and register every timer / subscription as a
 * reversible effect so unload and HMR roll back cleanly.
 * @param ctx - host context carrying redis + agents/llm/skills/sessions/workspaceRegistry.
 * @param config - deployment configuration (queue key, thresholds, intervals).
 */
export function apply(ctx: Context, config: QueueConfig): void {
  const cfg = resolveConfig(config ?? ({} as QueueConfig))
  assertConfig(cfg)

  if (!cfg.enabled) {
    console.log('[redis-queue] disabled by config')
    ctx.logger.info('[redis-queue] disabled by config')
    return
  }

  const queue = new QueueStore(ctx, cfg)
  const idem = new IdempotencyGuard(ctx, cfg)
  const workspaces = new WorkspaceProvisioner(ctx, cfg)
  const skills = new SkillResolver(ctx)
  const launcher = new SessionLauncher(ctx, cfg)
  const tracker = new ActiveSessionTracker(ctx, cfg, idem, queue)
  const monitor = new EnvironmentMonitor(ctx, cfg, tracker)
  const consumer = new TaskConsumer(ctx, cfg, { queue, idem, workspaces, skills, launcher, tracker })
  const scheduler = new Scheduler(ctx, cfg, monitor, consumer, queue)

  // Registrations are effects: subscriptions and timers auto-dispose on unload.
  ctx.effect(() => tracker.start(), 'redis-queue.tracker')
  ctx.effect(() => monitor.start(), 'redis-queue.monitor')
  ctx.effect(() => scheduler.start(), 'redis-queue.scheduler')

  const readyMsg = `ready (queue=${cfg.queueKey}, poll=${cfg.pollIntervalMs}ms, mode=${cfg.consumeMode}, maxSessions=${cfg.thresholds.maxConcurrentSessions})`
  console.log(`[redis-queue] ${readyMsg}`)
  ctx.logger.info('[redis-queue] %s', readyMsg)
}
