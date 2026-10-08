#!/usr/bin/env node
/**
 * The platform skip matrix, checked against its recorded state. Sets rather than counts, so two
 * rules drifting opposite ways cannot cancel out. Update the fixture with `--write`.
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

// `pathToFileURL`, not string concatenation: an absolute Windows path is `C:\...`, which neither
// `file://` nor the ESM loader accepts as written.
const { tests } = await import(pathToFileURL(catalogPath).href)
const fixture = JSON.parse(fs.readFileSync(fixturePath, 'utf8'))

// `platform-skips.ts` merges every matching rule into one `skip`, and the schema has one
// object there, so a definition carries at most one.
const ruleOf = (definition) => definition.skip

// Kept in step with `ConsumerBase.getTestSkipReason`: a coarse entry widens over the OS and
// nothing else. Without the second half, `platforms: ['desktop']` would be recorded here as
// skipping the Python run while that run executes the test, and the check would stay green.
const OPERATING_SYSTEMS = new Set(['macos', 'linux', 'windows', 'ios', 'android'])

function applies(entry, platform) {
  if (entry === platform) return true
  const segments = platform.split('-')
  const entrySegments = entry.split('-')
  if (entrySegments.length >= segments.length) return false
  if (!entrySegments.every((segment, index) => segment === segments[index])) return false
  return segments.slice(entrySegments.length).every((segment) => OPERATING_SYSTEMS.has(segment))
}

/** Unconditional skips are not platform policy. */
function isUnconditional(test) {
  const rule = ruleOf(test)
  return Boolean(rule) && !(rule.platforms ?? []).length
}

function skippedOn(platform) {
  return tests
    .filter((test) => !isUnconditional(test))
    .filter((test) => (ruleOf(test)?.platforms ?? []).some((entry) => applies(entry, platform)))
    .map((test) => test.testId)
    .sort()
}

/**
 * Every leg that registers with the producer. Listed here rather than read off the fixture: a leg
 * missing from the fixture would otherwise be silently unchecked, which is how the Snap leg lost
 * the packaged-app skips without this check noticing.
 */
const LEGS = [
  'desktop-macos',
  'desktop-linux',
  'desktop-windows',
  'electron-macos',
  'electron-linux',
  'electron-windows',
  'snap-linux',
  'mobile-ios',
  'mobile-android',
  'desktop-python'
]

const current = Object.fromEntries(LEGS.map((p) => [p, skippedOn(p)]))

const unrecorded = LEGS.filter((leg) => !(leg in fixture))
if (unrecorded.length > 0 && !process.argv.includes('--write')) {
  console.error(`❌ no recorded skip set for: ${unrecorded.join(', ')} — rerun with --write`)
  process.exit(1)
}

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
