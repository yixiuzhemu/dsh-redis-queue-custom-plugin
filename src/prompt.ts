/**
 * First-turn prompt construction from a task payload.
 *
 * @module dsh-redis-queue-custom-plugin/prompt
 */

import type { TaskPayload } from './types.ts'

/** Default template placeholders, replaced from the task fields. */
const PLACEHOLDERS = [
  'taskName',
  'platform',
  'projectId',
  'userCode',
  'sourceLang',
  'targetLang',
  'requestId',
  'agentId',
] as const

/**
 * Build the opening prompt for a task. When `template` is supplied it is used
 * verbatim with `{field}` placeholders substituted from the task; otherwise a
 * sensible translation-task default is emitted.
 *
 * @param task - the dequeued task payload.
 * @param template - optional deployment-provided template override.
 * @returns the prompt text delivered as the session's first user message.
 */
export function buildPrompt(task: TaskPayload, template?: string): string {
  if (template !== undefined && template.trim() !== '') {
    return renderTemplate(template, task)
  }
  return [
    `任务名称：${task.taskName}`,
    `平台：${task.platform}　项目：${task.projectId}　发起用户：${task.userCode}`,
    `请将以下内容从【${task.sourceLang}】翻译为【${task.targetLang}】。`,
    `会话/请求 ID：${task.requestId}`,
  ].join('\n')
}

/** Substitute `{field}` placeholders in a template from the task payload. */
function renderTemplate(template: string, task: TaskPayload): string {
  return template.replace(/\{(\w+)\}/g, (match, key: string) => {
    if (!(PLACEHOLDERS as readonly string[]).includes(key)) return match
    const value = (task as unknown as Record<string, unknown>)[key]
    return value === undefined || value === null ? '' : String(value)
  })
}
