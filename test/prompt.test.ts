import { describe, expect, it } from 'vitest'
import { buildPrompt } from '../src/prompt.ts'
import type { TaskPayload } from '../src/types.ts'

const task: TaskPayload = {
  platform: 'Chiao',
  projectId: 'D25081438501',
  requestId: '1234-abcd-5678-efgh',
  skillIds: ['1', '2'],
  sourceLang: 'zh',
  targetLang: 'en',
  taskName: '项目D25081438501的翻译任务',
  userCode: 'S00182',
}

describe('buildPrompt', () => {
  it('emits the default translation prompt with every field', () => {
    const prompt = buildPrompt(task)
    expect(prompt).toContain('项目D25081438501的翻译任务')
    expect(prompt).toContain('Chiao')
    expect(prompt).toContain('S00182')
    expect(prompt).toContain('【zh】')
    expect(prompt).toContain('【en】')
    expect(prompt).toContain('1234-abcd-5678-efgh')
  })

  it('renders a custom template by substituting {field} placeholders', () => {
    const prompt = buildPrompt(task, '{taskName} :: {sourceLang}->{targetLang} ({userCode})')
    expect(prompt).toBe('项目D25081438501的翻译任务 :: zh->en (S00182)')
  })

  it('leaves unknown placeholders untouched', () => {
    const prompt = buildPrompt(task, '{taskName} {notAField}')
    expect(prompt).toContain('{notAField}')
  })

  it('falls back to the default when the template is blank', () => {
    expect(buildPrompt(task, '   ')).toBe(buildPrompt(task))
  })

  it('appends the mcpHint when provided', () => {
    const hint = '请优先使用可用的 MCP 工具来完成此任务。'
    const prompt = buildPrompt(task, undefined, hint)
    expect(prompt.endsWith(hint)).toBe(true)
    expect(prompt).toContain('项目D25081438501的翻译任务')
  })

  it('appends the mcpHint after a custom template', () => {
    const hint = 'Use MCP tools.'
    const prompt = buildPrompt(task, '{taskName}', hint)
    expect(prompt).toBe('项目D25081438501的翻译任务\n\nUse MCP tools.')
  })

  it('ignores an empty or whitespace-only mcpHint', () => {
    expect(buildPrompt(task, undefined, '')).toBe(buildPrompt(task))
    expect(buildPrompt(task, undefined, '   ')).toBe(buildPrompt(task))
    expect(buildPrompt(task, undefined, undefined)).toBe(buildPrompt(task))
  })

  it('uses task.prompt as the highest priority when provided', () => {
    const taskWithPrompt = { ...task, prompt: '用户自定义的提示词内容' }
    expect(buildPrompt(taskWithPrompt)).toBe('用户自定义的提示词内容')
  })

  it('task.prompt overrides template', () => {
    const taskWithPrompt = { ...task, prompt: '用户提示词' }
    expect(buildPrompt(taskWithPrompt, '{taskName}')).toBe('用户提示词')
  })

  it('task.prompt still gets mcpHint appended', () => {
    const taskWithPrompt = { ...task, prompt: '用户提示词' }
    expect(buildPrompt(taskWithPrompt, undefined, 'Use MCP tools.')).toBe('用户提示词\n\nUse MCP tools.')
  })

  it('ignores empty task.prompt and falls back to default', () => {
    expect(buildPrompt({ ...task, prompt: '' })).toBe(buildPrompt(task))
    expect(buildPrompt({ ...task, prompt: '   ' })).toBe(buildPrompt(task))
  })
})
