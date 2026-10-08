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
})
