/**
 * Debug-level terminal logging. Only prints when `LOG_LEVEL=debug` (or `trace`)
 * is set in the environment. All diagnostic console output goes through this
 * so the terminal stays clean in normal operation.
 *
 * @module dsh-redis-queue-custom-plugin/debug
 */

/** True when the environment requests debug-level (or lower) logging. */
export function isDebugEnabled(): boolean {
  const level = (process.env.LOG_LEVEL ?? '').toLowerCase()
  return level === 'debug' || level === 'trace'
}

/** Print a message to stdout only when debug logging is enabled. */
export function debugLog(message: string): void {
  if (isDebugEnabled()) {
    console.log(message)
  }
}
