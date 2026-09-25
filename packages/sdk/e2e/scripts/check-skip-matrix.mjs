#!/usr/bin/env node
/**
 * The platform skip matrix, checked against its recorded state.
 *
 * Platform policy used to live as `SkipExecutor` registrations inside the
 * consumer entries. Moving it into the catalog is a transcription, and the
 * risk of a transcription is a rule that lands one test wide -- on legs
 * nobody watches closely, where a silently-skipped test looks exactly like a
 * passing one.
 *
 * `tests/resources/skip-matrix.json` is the set of test ids each leg skipped
 * before the move, resolved from the consumer registrations. This resolves the
 * same sets from the catalog and requires them identical. Sets rather than
 * counts: two rules that each drift by one test the other way would keep the
 * count and change the run.
 *
 * Update the fixture deliberately, in the same commit as the policy change
 * that justifies it, with `--write`.
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(here, '..')
const fixturePath = path.join(root, 'tests', 'resources', 'skip-matrix.json')
const catalogPath = path.join(root, 'dist', 'tests', 'test-definitions.js')

if (!fs.existsSync(catalogPath)) {
  console.error(`❌ ${path.relative(root, catalogPath)} is missing — run \`npm run build\` first.`)
  process.exit(1)
}

// `pathToFileURL`, not string concatenation: an absolute Windows path is
// `C:\...`, which neither `file://` nor the ESM loader accepts as written.
const { tests } = await import(pathToFileURL(catalogPath).href)
const fixture = JSON.parse(fs.readFileSync(fixturePath, 'utf8'))

/** Every skip rule on a definition, list or not, as a list. */
function rulesOf(definition) {
  const skip = definition.skip
  if (!skip) return []
  return Array.isArray(skip) ? skip : [skip]
}

/** Segment-prefix matching, the same rule `ConsumerBase` applies. */
function applies(entry, platform) {
  if (entry === platform) return true
  const segments = platform.split('-')
  const entrySegments = entry.split('-')
  if (entrySegments.length >= segments.length) return false
  return entrySegments.every((segment, index) => segment === segments[index])
}

/**
 * Unconditional skips are not platform policy.
 *
 * A `skip` with no `platforms` is dropped by the producer before it reaches
 * any leg -- the multi-GPU tests need a runner with two eligible GPUs, which
 * is not a statement about macOS or iOS. Counting them per leg would say the
 * policy differs by platform when it does not.
 */
function isUnconditional(test) {
  const rules = rulesOf(test)
  return rules.length > 0 && rules.every((rule) => !(rule.platforms ?? []).length)
}

function skippedOn(platform) {
  return tests
    .filter((test) => !isUnconditional(test))
    .filter((test) =>
      rulesOf(test).some((rule) => (rule.platforms ?? []).some((e) => applies(e, platform)))
    )
    .map((test) => test.testId)
    .sort()
}

const current = Object.fromEntries(Object.keys(fixture).map((p) => [p, skippedOn(p)]))

if (process.argv.includes('--write')) {
  fs.writeFileSync(fixturePath, `${JSON.stringify(current, null, 2)}\n`)
  console.log(`✅ wrote ${path.relative(root, fixturePath)}`)
  process.exit(0)
}

let failed = false
for (const [platform, expected] of Object.entries(fixture)) {
  const got = current[platform]
  const missing = expected.filter((id) => !got.includes(id))
  const extra = got.filter((id) => !expected.includes(id))
  if (missing.length === 0 && extra.length === 0) {
    console.log(`   ${platform.padEnd(18)} ${String(got.length).padStart(3)} skipped`)
    continue
  }
  failed = true
  console.error(`❌ ${platform}: ${got.length} skipped, expected ${expected.length}`)
  if (missing.length) console.error(`   no longer skipped: ${missing.join(', ')}`)
  if (extra.length) console.error(`   newly skipped:     ${extra.join(', ')}`)
}

if (failed) {
  console.error(
    '\nThe platform skip matrix changed. If that is the point of the change, ' +
      'rerun with --write and commit the fixture alongside it.'
  )
  process.exit(1)
}
console.log('✅ Skip matrix matches')
