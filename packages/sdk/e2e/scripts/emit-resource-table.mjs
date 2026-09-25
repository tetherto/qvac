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
// `pathToFileURL`, not a bare path: Node's ESM loader rejects an absolute
// Windows path because `C:\...` reads as a URL scheme it does not know, and
// the whole `build` fails there before a single test runs.
const load = (relative) => import(pathToFileURL(resolve(here, relative)).href)

const { RESOURCE_TABLE } = await load('../dist/tests/shared/resource-table.js')
const { PLATFORM_POLICY } = await load('../dist/tests/shared/platform-policy.js')

// Both artifacts, same rule: one typed source, one generated copy a non-JS
// client reads.
const artifacts = [
  {
    out: resolve(here, '../tests/resources/resource-table.json'),
    source: 'tests/shared/resource-table.ts',
    rendered: `${JSON.stringify(RESOURCE_TABLE, null, 2)}\n`,
    describe: () => `${Object.keys(RESOURCE_TABLE).length} resource keys`
  },
  {
    out: resolve(here, '../tests/resources/platform-policy.json'),
    source: 'tests/shared/platform-policy.ts',
    rendered: `${JSON.stringify(PLATFORM_POLICY, null, 2)}\n`,
    describe: () => `${Object.keys(PLATFORM_POLICY).length} platform policies`
  }
]

for (const artifact of artifacts) {
  if (process.argv.includes('--check')) {
    const current = existsSync(artifact.out) ? readFileSync(artifact.out, 'utf8') : ''
    if (current !== artifact.rendered) {
      console.error(`❌ ${artifact.out} is stale.\n   Run: npm run emit:resource-table`)
      process.exit(1)
    }
    console.log(`✅ ${artifact.out.split('/').pop()} matches ${artifact.source}`)
  } else {
    mkdirSync(dirname(artifact.out), { recursive: true })
    writeFileSync(artifact.out, artifact.rendered)
    console.log(`✅ wrote ${artifact.describe()} to ${artifact.out}`)
  }
}
