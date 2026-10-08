/**
 * Offline stub of `@deepseek-ai/dsh-llm` runtime surface used by the plugin
 * (`errorChain`, `createUserMessage`, `ReasoningEffortId`).
 */

export function errorChain(error: unknown): string {
  if (error instanceof Error) return error.message
  if (typeof error === 'string') return error
  try {
    return JSON.stringify(error)
  } catch {
    return String(error)
  }
}

export function createUserMessage(input: {
  content: Array<Record<string, unknown>>
  source: Record<string, unknown>
}): Record<string, unknown> {
  return { id: 'stub-user-message', ...input }
}

export function ReasoningEffortId(value: string): { readonly id: string } {
  return { id: value }
}
