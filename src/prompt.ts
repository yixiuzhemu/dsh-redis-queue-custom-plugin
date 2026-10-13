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
 * Build the opening prompt for a task. Priority: `task.prompt` (user-supplied)
 * > `template` (deployment override) > default translation prompt. When
 * `mcpHint` is non-empty it is appended as a final paragraph instructing the
 * agent to prefer MCP tools.
 *
 * @param task - the dequeued task payload.
 * @param template - optional deployment-provided template override.
 * @param mcpHint - optional MCP tool-usage hint appended to the prompt.
 * @returns the prompt text delivered as the session's first user message.
 */
export function buildPrompt(task: TaskPayload, template?: string, mcpHint?: string): string {
  const base = task.prompt !== undefined && task.prompt.trim() !== ''
    ? task.prompt
    : template !== undefined && template.trim() !== ''
      ? renderTemplate(template, task)
      : [
          `任务名称：${task.taskName}`,
          `平台：${task.platform} 项目：${task.projectId} 发起用户：${task.userCode}`,
          `请将以下内容从【${task.sourceLang}】翻译为【${task.targetLang}】。`,
          `会话/请求 ID：${task.requestId}`,
        ].join('\n')
  if (mcpHint !== undefined && mcpHint.trim() !== '') {
    return `${base}\n\n${mcpHint.trim()}`
  }
  return base
}

/** Substitute `{field}` placeholders in a template from the task payload. */
function renderTemplate(template: string, task: TaskPayload): string {
  return template.replace(/\{(\w+)\}/g, (match, key: string) => {
    if (!(PLACEHOLDERS as readonly string[]).includes(key)) return match
    const value = (task as unknown as Record<string, unknown>)[key]
    return value === undefined || value === null ? '' : String(value)
  })
}
