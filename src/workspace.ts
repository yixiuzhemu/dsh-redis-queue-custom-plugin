/**
 * Workspace provisioning: ensure a `projectId` maps to a host workspace,
 * creating it under a Redis distributed lock so concurrent consumers (across
 * instances) never race to create the same directory.
 *
 * Backed by the host `workspaceRegistry` service (the same primitive Remote-Task
 * uses). `registry.create` is idempotent by canonical path, and the lock is
 * released by `ctx.redis.lock.withLock` in its own `finally` (watchdog-renewed
 * during the critical section), so the lock is always freed after creation.
 *
 * @module dsh-redis-queue-custom-plugin/workspace
 */

import { homedir } from 'node:os'
import { join, resolve as resolvePath } from 'node:path'
import { mkdir } from 'node:fs/promises'
import type { Context } from '@deepseek-ai/cordis'
import type { Workspace, WorkspaceRegistry } from '@deepseek-ai/dsh-workspace'
import type { QueueConfig } from './config.ts'
import type { WorkspaceRef } from './types.ts'

/** Default workspace base directory when `workspaceRoot` is unset. */
function defaultWorkspaceRoot(): string {
  return join(homedir(), '.dsh', 'redis-queue', 'workspaces')
}

export class WorkspaceProvisioner {
  constructor(
    private readonly ctx: Context,
    private readonly cfg: QueueConfig,
  ) {}

  private registry(): WorkspaceRegistry {
    return this.ctx.workspaceRegistry as WorkspaceRegistry
  }

  private root(): string {
    return this.cfg.workspaceRoot.trim() === '' ? defaultWorkspaceRoot() : this.cfg.workspaceRoot
  }

  private cacheKey(projectId: string): string {
    return `DSH:TASK:ws:${projectId}`
  }

  /**
   * Ensure the workspace for `projectId` exists and return its id + path.
   *
   * Fast path: a cached projectId→workspaceId mapping that the registry still
   * knows is reused without taking the lock. Slow path: acquire the distributed
   * lock, double-check existence, create when missing, then refresh the cache.
   *
   * @param projectId - the task's workspace id (also the lock key + dir name).
   * @param title - optional workspace display title (defaults to projectId).
   * @returns the created or reused workspace reference.
   * @throws {Error} when the lock cannot be acquired or the directory is invalid
   *   (the consumer classifies these as recoverable vs. permanent).
   */
  async ensure(projectId: string, title?: string): Promise<WorkspaceRef> {
    const redis = this.ctx.redis
    const cacheKey = this.cacheKey(projectId)

    // Fast path — cache hit that the registry still owns: reuse without locking.
    const cached = await redis.get<string>(cacheKey)
    if (cached !== null) {
      const ws = this.registry().get(cached)
      if (ws !== undefined) return { id: String(ws.id), path: ws.path }
    }

    const lockKey = `${this.cfg.lock.keyPrefix}:${projectId}`
    return redis.lock.withLock(
      lockKey,
      async () => {
        const target = resolvePath(this.root(), projectId)
        // Double-check inside the lock: another instance may have created it
        // while we waited to acquire.
        const existing = this.findByPath(target)
        let ws: Workspace
        if (existing !== undefined) {
          ws = existing
        } else {
          await mkdir(target, { recursive: true })
          ws = await this.registry().create(target, title ?? projectId)
        }
        await redis.setEx(cacheKey, String(ws.id), this.cfg.lock.wsCacheTtlMs, 'ms')
        this.ctx.logger.info(
          '[redis-queue] workspace ready projectId=%s id=%s reused=%s',
          projectId,
          String(ws.id),
          existing !== undefined,
        )
        return { id: String(ws.id), path: ws.path }
      },
      {
        ttl: this.cfg.lock.ttlMs,
        retryCount: this.cfg.lock.retryCount,
        retryInterval: this.cfg.lock.retryIntervalMs,
        onLost: (key) => this.ctx.logger.warn('[redis-queue] workspace lock lost: %s', key),
      },
    )
  }

  /** Find a registered workspace whose canonical path equals `target`. */
  private findByPath(target: string): Workspace | undefined {
    return this.registry()
      .list()
      .find((w) => w.path === target)
  }
}
