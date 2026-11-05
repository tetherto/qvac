#!/usr/bin/env node
/**
 * Plan the models a CI leg needs and where the SDK keeps each one, for
 * .github/actions/sdk-e2e-model-cache. Selection: the run's tests (`selectRunTests`), their
 * deps, then every model constant the bootstrap would download. Where each model lives comes
 * from `@qvac/inference/model-cache-layout`, so the inference build the run loads decides.
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
import { createHash } from 'node:crypto'
import { mkdirSync, writeFileSync, appendFileSync } from 'node:fs'
import { dirname, resolve, relative } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { parseArgs } from 'node:util'

const here = dirname(fileURLToPath(import.meta.url))
const projectDir = resolve(here, '..')
const load = (relativePath) => import(pathToFileURL(resolve(projectDir, relativePath)).href)

/**
 * Per family: bootstrap consumer, skip-matching platform label, and resource-table label (they
 * differ only for Python).
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
  // Registers as `desktop-python`, reads the table as `desktop` (qvac_e2e/resources.py).
  python: {
    consumer: 'desktop',
    platform: (_os, config) => externalPlatform(config, 'python'),
    resourcePlatform: () => 'desktop'
  },
  snap: { consumer: 'electron', platform: () => 'snap-linux', resourcePlatform: () => 'snap-linux' }
}

function externalPlatform(config, name) {
  const entry = config.consumers?.external?.find((candidate) => candidate.name === name)
  if (!entry) throw new Error(`No external consumer named "${name}" in qvac-test.config.js`)
  return entry.platform
}

// The `platform` @qvac/inference sees on each host, which picks its Core ML sets.
const INFERENCE_PLATFORM = { macos: 'darwin', linux: 'linux', windows: 'win32' }

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
if (typeof testSuite.selectRunTests !== 'function') {
  throw new Error('@qvac/test-suite has no selectRunTests; install a version that exports it')
}
const sdk = await import('@qvac/sdk')
const { RESOURCE_TABLE } = await load('dist/catalog/resource-table.js')
const { applyResourceTable } = await load('dist/catalog/resource-table-types.js')
const { ResourceManager } = await load('dist/runners/js/shared/resource-manager.js')
const { collectTestDeps } = await load('dist/runners/js/shared/collect-test-deps.js')
const { getModelCacheLayout } = await import('@qvac/inference/model-cache-layout').catch(
  (error) => {
    throw new Error(
      `@qvac/inference has no model-cache-layout export; build it from this branch (${error.message})`
    )
  }
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

const cacheRoot = values['cache-root'].replace(/\\/g, '/').replace(/\/+$/, '')
const legs = []
const constants = []

for (const family of families) {
  const { consumer } = FAMILIES[family]
  const platform = FAMILIES[family].platform(values.os, config)
  const resourcePlatform = FAMILIES[family].resourcePlatform(values.os)
  const selection = testSuite.selectRunTests(catalog, { ...selectionOptions, platform })
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
  const leg = await resources.preDownloadConstants({ allowedDeps: deps })
  constants.push(...leg.constants)
  legs.push({ family, consumer, platform, resourcePlatform, deps: [...deps].sort() })
  console.log(
    `${family} (${platform}): ${selection.tests.length} test(s), ${deps.size} dep(s), ` +
      `${leg.constants.length} model constant(s)`
  )
}

const sha256 = (text) => createHash('sha256').update(text, 'utf8').digest('hex')
const shortHash = (text) => sha256(text).slice(0, 16)
const byPath = new Map(
  sdk.models.map((item) => [`${item.registrySource}:${item.registryPath}`, item])
)
const byName = new Map(sdk.models.map((item) => [item.name, item]))

// One entry per cached path; aliases of a registry model, and the seed's legs, share it.
const byLayout = new Map()
const unresolved = new Set()
for (const { constant } of constants) {
  const item =
    byPath.get(`${constant.registrySource}:${constant.registryPath}`) ?? byName.get(constant.name)
  const layout = item && getModelCacheLayout(item, INFERENCE_PLATFORM[values.os], shortHash)
  if (!layout) {
    unresolved.add(constant.name)
    continue
  }
  const known = byLayout.get(layout.path)
  if (known) {
    if (!known.models.includes(constant.name)) known.models.push(constant.name)
    continue
  }
  const single = layout.files.length === 1 && layout.files[0].path === layout.path
  byLayout.set(layout.path, {
    // The key: a file's own checksum, or a digest of a set's file names and checksums.
    contentId: single
      ? layout.files[0].sha256
      : sha256(
          layout.files
            .map((file) => `${file.path.slice(layout.path.length)}:${file.sha256}`)
            .sort()
            .join('\n')
        ),
    path: `${cacheRoot}/${layout.path}`,
    files: layout.files.map((file) => ({ ...file, path: `${cacheRoot}/${file.path}` })),
    size: layout.files.reduce((sum, file) => sum + file.size, 0),
    models: [constant.name]
  })
}

const entries = [...byLayout.values()].sort((a, b) => (a.path < b.path ? -1 : 1))
const plan = { version: 1, cacheRoot, legs, entries, unresolved: [...unresolved].sort() }
const bytes = entries.reduce((sum, entry) => sum + entry.size, 0)

const outPath = resolve(values.out)
mkdirSync(dirname(outPath), { recursive: true })
writeFileSync(outPath, `${JSON.stringify(plan, null, 2)}\n`)

if (plan.unresolved.length > 0) {
  console.log(`::warning::No cache layout for ${plan.unresolved.join(', ')}; these stay uncached`)
}
console.log(
  `📋 ${entries.length} model cache entr(ies), ${(bytes / 1e9).toFixed(1)} GB, ` +
    `written to ${relative(process.cwd(), outPath) || outPath}`
)

if (process.env.GITHUB_OUTPUT) {
  // First leg's deps: the in-Snap bootstrap cannot read the plan file.
  appendFileSync(
    process.env.GITHUB_OUTPUT,
    `plan=${outPath}\ndeps=${JSON.stringify(legs[0].deps)}\n`
  )
}
