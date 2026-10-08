/**
 * Skill resolution against Skills-Manager and injection into an agent scope.
 *
 * A task carries business `skillIds` (external catalog ids). Each id is fetched
 * through Skills-Manager's dedicated by-id entry point `resolveSkillById`, which
 * installs the skill on demand and returns its record; the record's kebab-case
 * `name` is what the name-addressed `ctx.skills` registry resolves at injection
 * time. Resolution is tolerant: an id that cannot be resolved is logged once and
 * skipped, never failing the whole task (mirrors Remote-Task's `injectSkills`).
 *
 * @module dsh-redis-queue-custom-plugin/skills
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { SkillDefinition } from '@deepseek-ai/dsh-skill'

/**
 * The optional Skills-Manager host service. Accessed through `ctx.get` so this
 * plugin still loads when Skills-Manager is not mounted (resolution then falls
 * back to the layered `ctx.skills` registry).
 */
export interface SkillsManagerLike {
  /**
   * Fetch an enabled skill by its external catalog id, installing it on demand
   * when a remote resolver is configured. This is Skills-Manager's dedicated
   * by-id entry point: the `ctx.skills` registry is name-addressed and only
   * lists already-installed skills, so a by-id fetch must go through here.
   * Resolves to `undefined` when the id cannot be resolved.
   */
  resolveSkillById(id: string): Promise<{ id?: string; name?: string } | undefined>
}

export class SkillResolver {
  constructor(private readonly ctx: Context) {}

  /**
   * Read the Skills-Manager service when mounted. Cordis' `ctx.get(name)`
   * throws when the service is not registered; we swallow that so this plugin
   * still runs (falling back to the layered `ctx.skills` registry) when
   * Skills-Manager is absent from the profile.
   */
  private manager(): SkillsManagerLike | undefined {
    try {
      return this.ctx.get<SkillsManagerLike>('skillsManager')
    } catch {
      return undefined
    }
  }

  /**
   * Resolve business skill ids to the skill names to inject. Each id is fetched
   * from Skills-Manager by id (installing on demand); an id that resolves to no
   * record is skipped with a warning.
   *
   * @param skillIds - the task's requested skill ids (external catalog ids).
   * @returns the resolved skill names, in request order, safe to inject through
   *   the name-addressed `ctx.skills` registry.
   */
  async resolve(skillIds: string[]): Promise<string[]> {
    if (skillIds.length === 0) return []
    const manager = this.manager()
    const resolved: string[] = []

    for (const id of skillIds) {
      const name = manager ? await this.resolveViaManager(manager, id) : await this.resolveViaRegistry(id)
      if (name === undefined) {
        this.ctx.logger.warn('[redis-queue] skill not found in Skills-Manager, skipped: %s', id)
        continue
      }
      resolved.push(name)
    }
    return resolved
  }

  /**
   * Fetch one id through Skills-Manager's by-id entry point, which installs a
   * remote skill on demand. Returns the record's kebab-case name — the key the
   * name-addressed `ctx.skills` registry resolves at injection time.
   */
  private async resolveViaManager(manager: SkillsManagerLike, id: string): Promise<string | undefined> {
    const record = await manager.resolveSkillById(id)
    return record?.name
  }

  /** Fallback when Skills-Manager is absent: probe the layered skills registry. */
  private async resolveViaRegistry(id: string): Promise<string | undefined> {
    const def = await this.ctx.skills.get(id) as SkillDefinition | undefined
    return def?.name
  }
}

/**
 * Inject resolved skill names into one agent's scope so the per-session catalog
 * renders them. A name that no longer resolves at composition time is skipped
 * silently (resolution already warned during {@link SkillResolver.resolve}).
 *
 * @param ctx - plugin context carrying the skills registry.
 * @param agentCtx - the agent-scoped context whose layer receives registrations.
 * @param agent - the agent being composed; used as the resolution scope key.
 * @param names - resolved skill names to inject (name-addressed registry keys).
 * @param cwd - working directory for cwd-sensitive skill resolution.
 */
export async function injectSkills(
  ctx: Context,
  agentCtx: Context,
  agent: Agent,
  names: string[],
  cwd?: string,
): Promise<void> {
  if (names.length === 0) return
  for (const name of names) {
    const def = await ctx.skills.get(name, { scope: agent, cwd }) as SkillDefinition | undefined
    if (def === undefined) continue
    agentCtx.skills.register({
      name: def.name,
      description: def.description,
      ...(def.content !== undefined ? { content: def.content } : {}),
      ...(def.source !== undefined ? { source: def.source } : {}),
      ...(def.whenToUse !== undefined ? { whenToUse: def.whenToUse } : {}),
      ...(def.resourceBase !== undefined ? { resourceBase: def.resourceBase } : {}),
    })
  }
}
