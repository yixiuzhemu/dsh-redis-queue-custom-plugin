/**
 * Remove every build artifact: the package's `lib/` output and the TypeScript
 * build-info file. Dependency-free Node so it works before `pnpm install`
 * resolves the harness peers.
 */

import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))

/** Remove one path if it exists, ignoring a missing target. */
async function remove(target) {
  await rm(target, { recursive: true, force: true })
  console.log(`removed ${target.slice(root.length)}`)
}

await remove(join(root, 'lib'))
await remove(join(root, 'tsconfig.tsbuildinfo'))
