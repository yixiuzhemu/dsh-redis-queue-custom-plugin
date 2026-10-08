#!/usr/bin/env node
/**
 * Pre-pack guard: every place that must carry the npm package name actually
 * does. These are plain strings no compiler checks — the bundle patch name —
 * so a rename silently ships broken if they drift.
 */
import fs from 'node:fs'

const name = JSON.parse(fs.readFileSync('package.json', 'utf8')).name

const failures = []

const patch = fs.readFileSync('cordis.patch.yml', 'utf8')
if (!patch.includes(`name: '${name}'`)) {
  failures.push(`cordis.patch.yml must insert by package name '${name}'`)
}

if (!fs.existsSync('lib/index.js')) {
  failures.push('lib/index.js is missing — run `pnpm build` before packing')
}
if (!fs.existsSync('lib/types/index.d.ts')) {
  failures.push('lib/types/index.d.ts is missing — run `pnpm build` before packing')
}

if (failures.length > 0) {
  console.error('preflight failed:\n- ' + failures.join('\n- '))
  process.exit(1)
}
console.log(`preflight ok: ${name}`)
