#!/usr/bin/env node
/**
 * Write the shared resource table out as JSON for clients that cannot read TS.
 *
 * `tests/shared/resource-table.ts` is the source: it is typed, and the
 * consumers apply it directly. The JSON beside it is a build product a non-JS
 * client reads, and a build product that is edited by hand is a second source
 * of truth that drifts — which is the exact failure this migration exists to
 * remove. So it is generated here, from the one table, on every build.
 *
 * `--check` fails instead of writing, for a gate that wants to know the
 * committed copy is current without touching the tree.
 */
import { writeFileSync, readFileSync, existsSync, mkdirSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const out = resolve(here, '../tests/resources/resource-table.json')
// `pathToFileURL`, not a bare path: Node's ESM loader rejects an absolute
// Windows path because `C:\...` reads as a URL scheme it does not know, and
// the whole `build` fails there before a single test runs.
const { RESOURCE_TABLE } = await import(
  pathToFileURL(resolve(here, '../dist/tests/shared/resource-table.js')).href
)
const rendered = `${JSON.stringify(RESOURCE_TABLE, null, 2)}\n`

if (process.argv.includes('--check')) {
  const current = existsSync(out) ? readFileSync(out, 'utf8') : ''
  if (current !== rendered) {
    console.error(
      `❌ ${out} is stale.\n   Run: npm run emit:resource-table`
    )
    process.exit(1)
  }
  console.log('✅ resource table JSON matches tests/shared/resource-table.ts')
} else {
  mkdirSync(dirname(out), { recursive: true })
  writeFileSync(out, rendered)
  console.log(`✅ wrote ${Object.keys(RESOURCE_TABLE).length} resource keys to ${out}`)
}
