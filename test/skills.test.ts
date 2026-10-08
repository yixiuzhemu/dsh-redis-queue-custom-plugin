import { describe, expect, it } from 'vitest'
import { SkillResolver, type SkillsManagerLike } from '../src/skills.ts'
import { createTestHost } from './stubs/host.ts'

function manager(records: Array<{ id?: string; name?: string }>): SkillsManagerLike {
  return {
    // Mirrors Skills-Manager: fetch a record by its external catalog id.
    resolveSkillById: async (id: string) => records.find((r) => r.id === id),
  }
}

describe('SkillResolver.resolve', () => {
  it('returns [] for an empty request without touching the manager', async () => {
    const host = createTestHost({ skillsManager: manager([{ id: 'ext-1', name: 'a' }]) })
    const resolver = new SkillResolver(host.ctx)
    expect(await resolver.resolve([])).toEqual([])
  })

  it('resolves each id to its skill name, keeping the request order', async () => {
    const host = createTestHost({ skillsManager: manager([{ id: 'ext-1', name: 'a' }, { id: 'ext-2', name: 'b' }]) })
    const resolver = new SkillResolver(host.ctx)
    expect(await resolver.resolve(['ext-2', 'ext-1'])).toEqual(['b', 'a'])
  })

  it('skips an unknown skill with exactly one warning, keeping the resolved ones', async () => {
    const host = createTestHost({ skillsManager: manager([{ id: 'ext-1', name: 'a' }]) })
    const resolver = new SkillResolver(host.ctx)
    const resolved = await resolver.resolve(['ext-1', 'ghost'])
    expect(resolved).toEqual(['a'])
    const warnings = host.logText('warn')
    expect(warnings).toContain('ghost')
    expect(warnings).toContain('skipped')
  })

  it('falls back to the layered ctx.skills registry when Skills-Manager is absent', async () => {
    const host = createTestHost({ knownSkills: { sk1: { name: 'sk1', description: 'd' } } })
    const resolver = new SkillResolver(host.ctx)
    const resolved = await resolver.resolve(['sk1', 'nope'])
    expect(resolved).toEqual(['sk1'])
    expect(host.logText('warn')).toContain('nope')
  })

  it('falls back to ctx.skills.get when ctx.get(skillsManager) throws (D4)', async () => {
    // Real Cordis' ctx.get(name) throws when the service is not registered.
    // The stub host defaults to that behavior; the resolver must swallow the
    // throw and fall back to the layered registry instead of failing the task.
    const host = createTestHost({
      getThrowsOnMissing: true,
      knownSkills: { alpha: { name: 'alpha', description: 'd' } },
    })
    // Sanity: confirm the stub actually throws for an unregistered service.
    expect(() => host.ctx.get('skillsManager')).toThrow(/service not found/)

    const resolver = new SkillResolver(host.ctx)
    const resolved = await resolver.resolve(['alpha', 'ghost'])
    expect(resolved).toEqual(['alpha'])
    expect(host.logText('warn')).toContain('ghost')
    expect(host.logText('warn')).toContain('skipped')
  })

  it('uses Skills-Manager when ctx.get returns it (no throw path)', async () => {
    const host = createTestHost({
      getThrowsOnMissing: true,
      skillsManager: manager([{ id: 'ext-9', name: 'nine' }]),
      knownSkills: { nine: { name: 'nine', description: 'd' } },
    })
    const resolver = new SkillResolver(host.ctx)
    expect(await resolver.resolve(['ext-9'])).toEqual(['nine'])
  })
})
