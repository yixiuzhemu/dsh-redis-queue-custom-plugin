/**
 * Offline stub of `@deepseek-ai/schemastery`.
 *
 * `config.ts` builds a schema at module load; the tests never validate against
 * it, so a permissive chainable proxy (every method returns a fresh chainable)
 * is enough to construct `Config` without throwing.
 */

function chainable(): any {
  const target = function () {} as any
  return new Proxy(target, {
    get(_t, prop) {
      if (prop === 'then') return undefined // keep it non-thenable
      return (..._args: unknown[]) => chainable()
    },
    apply() {
      return chainable()
    },
  })
}

const z = chainable()
export default z
