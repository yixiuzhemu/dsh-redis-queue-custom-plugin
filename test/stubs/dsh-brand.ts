/**
 * Offline stub of `@deepseek-ai/dsh-brand`: branding is a no-op passthrough at
 * runtime (the phantom type is erased), so the plain string is returned.
 */

export function brandString<T>(value: string): T {
  return value as unknown as T
}
