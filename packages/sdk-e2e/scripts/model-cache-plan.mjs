#!/usr/bin/env node
/**
 * Work out which models a CI leg needs and where the SDK keeps each one, so the leg restores
 * exactly those from the per-model cache (.github/actions/sdk-e2e-model-cache) and bootstraps
 * only what the cache did not have.
 *
 * The selection is the run's own: the same suite/filter/include options the producer queues
 * from, minus the tests the leg's platform skips (`selectRunTests` from @qvac/test-suite), then
 * the ResourceManager deps those tests declare, then every model constant the bootstrap would
 * pre-download for them.
 *
 *   node scripts/model-cache-plan.mjs --family desktop --suite smoke --out plan.json
 *   node scripts/model-cache-plan.mjs --family desktop,python,electron --out plan.json   # seed
 *
 * Options:
 *   --family        desktop | electron | python | snap; comma-separated for a union (seed)
 *   --os            macos | linux | windows (default: this host)
 *   --suite, --exclude-suite, --filter, --include   the run's test selection
 *   --cache-root    SDK models cache dir, relative to the repository root, which is where the
 *                   cache action runs (default packages/sdk-e2e/.qvac-cache)
 *   --out           plan JSON to write (required)
 *
 * Must run after `npm run build`: it reads the compiled catalog and runners.
 */
import { mkdirSync, writeFileSync, appendFileSync } from 'node:fs'
import { dirname, resolve, relative } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { parseArgs } from 'node:util'

const here = dirname(fileURLToPath(import.meta.url))
const projectDir = resolve(here, '..')
const load = (relativePath) => import(pathToFileURL(resolve(projectDir, relativePath)).href)

/**
 * Per family: the consumer entry that bootstraps it, the label its tests register with (which
 * platform skips apply), and the label its client resolves the resource table under (which
 * `on`/`configOn` entries apply). The two differ only for Python.
 */
const FAMILIES = {
  desktop: {
    consumer: 'desktop',
    platform: (os) => `desktop-${os}`,
    resourcePlatform: (os) => `desktop-${os}`
  },
  electron: {
    consumer: 'electron',
    platform: (os) => `electron-${os}`,
    resourcePlatform: (os) => `electron-${os}`
  },
  // The Python client registers as `desktop-python` but reads the table as QVAC_RESOURCE_PLATFORM,
  // `desktop` by default (runners/python/qvac_e2e/resources.py); the desktop entry warms it.
  python: {
    consumer: 'desktop',
    platform: (_os, config) => externalPlatform(config, 'python'),
    resourcePlatform: () => 'desktop'
  },
  // The Snap runs the Electron entry under its own label (test-suite's createSnapRuntimeEnv).
  snap: { consumer: 'electron', platform: () => 'snap-linux', resourcePlatform: () => 'snap-linux' }
}

function externalPlatform(config, name) {
  const entry = config.consumers?.external?.find((candidate) => candidate.name === name)
  if (!entry) throw new Error(`No external consumer named "${name}" in qvac-test.config.js`)
  return entry.platform
}

function hostOs() {
  if (process.platform === 'darwin') return 'macos'
  if (process.platform === 'win32') return 'windows'
  return 'linux'
}

const { values } = parseArgs({
  options: {
    family: { type: 'string', default: 'desktop' },
    os: { type: 'string', default: hostOs() },
    suite: { type: 'string', default: '' },
    'exclude-suite': { type: 'string', default: '' },
    filter: { type: 'string', default: '' },
    include: { type: 'string', default: '' },
    'cache-root': { type: 'string', default: 'packages/sdk-e2e/.qvac-cache' },
    out: { type: 'string' }
  }
})

if (!values.out) throw new Error('--out is required')
if (!['macos', 'linux', 'windows'].includes(values.os)) {
  throw new Error(`--os must be macos, linux or windows, got "${values.os}"`)
}
const families = values.family
  .split(',')
  .map((family) => family.trim())
  .filter(Boolean)
for (const family of families) {
  if (!FAMILIES[family]) throw new Error(`Unknown --family "${family}"`)
}

const testSuite = await import('@qvac/test-suite')
const sdk = await import('@qvac/sdk')
const { RESOURCE_TABLE } = await load('dist/catalog/resource-table.js')
const { applyResourceTable } = await load('dist/catalog/resource-table-types.js')
const { ResourceManager } = await load('dist/runners/js/shared/resource-manager.js')
const { collectTestDeps } = await load('dist/runners/js/shared/collect-test-deps.js')
const { buildModelCachePlan, mergeModelCacheEntries } = await load(
  'dist/runners/js/shared/model-cache-plan.js'
)

if (!Array.isArray(sdk.models)) {
  throw new Error('@qvac/sdk does not export the registry `models` list this plan is built from')
}

const config = await testSuite.loadConfig(projectDir)
const catalog = await testSuite.loadTests(config, projectDir)
const selectionOptions = {
  suite: values.suite || undefined,
  excludeSuite: values['exclude-suite'] || undefined,
  filter: values.filter || undefined,
  include: values.include || undefined
}

/**
 * Transitional copy of `selectRunTests` (packages/test-suite/src/utils/test-selection.ts and
 * platform-match.ts) for a framework released before it. Delete it once packages/sdk-e2e
 * depends on a @qvac/test-suite that exports `selectRunTests`.
 */
function selectRunTestsFallback(tests, options) {
  const list = (value) =>
    (value ?? '')
      .split(',')
      .map((item) => item.trim())
      .filter(Boolean)
  const operatingSystems = new Set(['macos', 'linux', 'windows', 'ios', 'android'])
  const matches = (platform, declared) => {
    const segments = platform.split('-')
    return declared.some((entry) => {
      if (entry === platform) return true
      const entrySegments = entry.split('-')
      if (entrySegments.length >= segments.length) return false
      if (!entrySegments.every((segment, index) => segment === segments[index])) return false
      return segments.slice(entrySegments.length).every((segment) => operatingSystems.has(segment))
    })
  }

  let selected = tests
  if (options.suite) {
    const suites = list(options.suite)
    selected = selected.filter((test) => test.suites?.some((suite) => suites.includes(suite)))
  }
  if (options.excludeSuite) {
    const excluded = list(options.excludeSuite)
    selected = selected.filter((test) => !test.suites?.some((suite) => excluded.includes(suite)))
  }
  if (options.filter) {
    const filters = list(options.filter)
    selected = selected.filter((test) =>
      filters.some((filter) => test.testId.startsWith(filter) || test.metadata?.category === filter)
    )
  }
  const unknownTestIds = []
  if (options.include) {
    const catalogIds = new Set(tests.map((test) => test.testId))
    const keep = new Set(selected.map((test) => test.testId))
    for (const id of list(options.include)) {
      if (catalogIds.has(id)) keep.add(id)
      else unknownTestIds.push(id)
    }
    selected = tests.filter((test) => keep.has(test.testId))
  }

  const kept = []
  const platformSkippedTestIds = []
  for (const test of selected) {
    const skipped = test.skip?.platforms?.length && matches(options.platform, test.skip.platforms)
    if (skipped) platformSkippedTestIds.push(test.testId)
    else kept.push(test)
  }
  return { tests: kept, platformSkippedTestIds, unknownTestIds }
}

/** The tests one leg executes: what the producer queues, minus what the platform skips. */
function selectLegTests(platform) {
  const select =
    typeof testSuite.selectRunTests === 'function'
      ? testSuite.selectRunTests
      : selectRunTestsFallback
  return select(catalog, { ...selectionOptions, platform })
}

const cacheRoot = values['cache-root'].replace(/\\/g, '/').replace(/\/+$/, '')
const legs = []
const entryLists = []
const unresolved = new Set()

for (const family of families) {
  const { consumer } = FAMILIES[family]
  const platform = FAMILIES[family].platform(values.os, config)
  const resourcePlatform = FAMILIES[family].resourcePlatform(values.os)
  const selection = selectLegTests(platform)
  for (const id of selection.unknownTestIds) {
    console.log(`::warning::--include names "${id}", which is not in the catalog`)
  }
  const deps = collectTestDeps(selection.tests)

  const resources = new ResourceManager()
  applyResourceTable(
    RESOURCE_TABLE,
    resourcePlatform,
    (dep, definition) => resources.define(dep, definition),
    {
      const: (name) => sdk[name],
      asset: (kind, file) => resolve(projectDir, 'assets', kind, file)
    }
  )
  const { constants } = await resources.preDownloadConstants({ allowedDeps: deps })
  const plan = buildModelCachePlan({ constants, registry: sdk.models, os: values.os, cacheRoot })
  for (const name of plan.unresolved) unresolved.add(name)
  entryLists.push(plan.entries)

  legs.push({
    family,
    consumer,
    platform,
    resourcePlatform,
    selectedTests: selection.tests.length,
    platformSkippedTests: selection.platformSkippedTestIds.length,
    deps: [...deps].sort(),
    entries: plan.entries.length
  })
  console.log(
    `${family} (${platform}): ${selection.tests.length} test(s), ${deps.size} dep(s), ` +
      `${constants.length} model constant(s) in ${plan.entries.length} cache entr(ies)`
  )
}

const entries = mergeModelCacheEntries(entryLists)
const expectedBytes = entries.reduce((sum, entry) => sum + entry.expectedSize, 0)
const plan = {
  version: 1,
  os: values.os,
  cacheRoot,
  legs,
  entries,
  unresolved: [...unresolved].sort()
}

const outPath = resolve(values.out)
mkdirSync(dirname(outPath), { recursive: true })
writeFileSync(outPath, `${JSON.stringify(plan, null, 2)}\n`)

if (plan.unresolved.length > 0) {
  console.log(`::warning::No registry entry for ${plan.unresolved.join(', ')}; these stay uncached`)
}
console.log(
  `📋 ${entries.length} model cache entr(ies), ${(expectedBytes / 1e9).toFixed(1)} GB, ` +
    `written to ${relative(process.cwd(), outPath) || outPath}`
)

if (process.env.GITHUB_OUTPUT) {
  // `deps` is the first leg's: a test leg plans one family, and the Snap leg hands it to the
  // bootstrap inside the Snap, which cannot read the plan file.
  appendFileSync(
    process.env.GITHUB_OUTPUT,
    `plan=${outPath}\ndeps=${JSON.stringify(legs[0].deps)}\n`
  )
}
