'use strict'

// Single source of truth for porting the DESKTOP integration suites onto the
// mobile test addon.
//
// The desktop suite lives in ../../tests/integration_js/<suite>/ as standalone
// Bare addons, each with its own binding and each test doing `require('.')`
// against its own addon. The mobile harness (qvac-test-addon-mobile) is strictly
// one-addon-per-app, and only bundles files under the addon's own test/ dir — so
// the desktop files cannot be referenced in place. Instead they are COPIED into
// test/integration/<suite>/ with a single mechanical rewrite (`require('.')` ->
// the unified mobile addon) by generate-mobile-integration-tests.js, and
// validate-mobile-tests.js re-derives the same output to prove the committed
// copies have not drifted from the desktop originals.
//
// Consequence: never hand-edit anything under test/integration/. Change the
// desktop test and re-run `npm run test:mobile:generate`.

const fs = require('fs')
const path = require('path')

const mobileRoot = path.resolve(__dirname, '..', '..')
const desktopRoot = path.resolve(mobileRoot, '..', 'tests', 'integration_js')
const integrationDir = path.join(mobileRoot, 'test', 'integration')
const mobileDir = path.join(mobileRoot, 'test', 'mobile')
const autoFile = path.join(mobileDir, 'integration.auto.cjs')
const groupsFile = path.join(mobileDir, 'test-groups.json')

// Addon glue, not test material: each desktop sub-package has its own
// binding.js/index.js pointing at its own native module. The mobile addon has
// its own unified equivalents, so these are never copied.
const SKIP_FILES = new Set(['binding.js', 'index.js'])

const BANNER = [
  '// AUTO-GENERATED FROM THE DESKTOP SUITE — DO NOT EDIT.',
  '//',
  '// Source: tests/integration_js/%SUITE%/%FILE%',
  '// Regenerate: npm run test:mobile:generate   (verify: npm run test:mobile:validate)',
  '//',
  "// Only mechanical change from the source: `require('.')` is repointed at the",
  '// unified mobile addon, because the mobile harness runs one aggregated addon',
  '// instead of the three standalone desktop sub-packages.',
  ''
].join('\n')

function listSuites() {
  if (!fs.existsSync(desktopRoot)) {
    throw new Error(`Desktop suite root not found: ${desktopRoot}`)
  }
  return fs
    .readdirSync(desktopRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .filter((name) => fs.existsSync(path.join(desktopRoot, name, 'package.json')))
    .sort()
}

function listSuiteFiles(suite) {
  return fs
    .readdirSync(path.join(desktopRoot, suite))
    .filter((name) => name.endsWith('.js') && !SKIP_FILES.has(name))
    .sort()
}

// A test entry is what the harness invokes as an independent on-device test:
// `test.js` or `*.test.js`. Worker scripts (worker-*.js) are support files that
// the tests spawn, so they are copied but never become entries.
function isTestEntry(file) {
  return file === 'test.js' || file.endsWith('.test.js')
}

function pascal(parts) {
  return parts
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join('')
}

// logger/teardown.test.js -> runLoggerTeardownTest
// js-create-double-first-call/test.js -> runJsCreateDoubleFirstCallTest
function toFunctionName(suite, file) {
  const suiteParts = suite.split(/[^a-zA-Z0-9]+/)
  const baseParts = file.replace(/\.js$/, '').split(/[^a-zA-Z0-9]+/)
  while (baseParts.length && baseParts[baseParts.length - 1].toLowerCase() === 'test') {
    baseParts.pop()
  }
  return `run${pascal([...suiteParts, ...baseParts])}Test`
}

// The unified addon's index.js, relative to test/integration/<suite>/<file>.
const ADDON_REQUIRE = '../../../index.js'

function transformSource(suite, file, source) {
  const banner = BANNER.replace('%SUITE%', suite).replace('%FILE%', file)

  // 1) Desktop tests and their workers load their own sub-package addon via
  //    `require('.')`; repoint at the aggregated mobile addon.
  let body = source.replace(/require\('\.'\)/g, `require('${ADDON_REQUIRE}')`)

  // 2) bare-thread worker paths must not be CWD-relative. The desktop suite gets
  //    away with `new Thread('./worker-x.js')` because it runs with cwd set to
  //    the sub-package dir; the mobile app (and any run from another cwd)
  //    resolves it against the wrong directory and fails MODULE_NOT_FOUND.
  //    require.resolve() anchors it to THIS module's directory instead, which is
  //    correct in every cwd. The suite dir is mirrored, so the worker sits
  //    alongside its test.
  body = body.replace(
    /new Thread\('(\.\/[^']+)'/g,
    (_match, spec) => `new Thread(require.resolve('${spec}')`
  )

  return `${banner}${body}`
}

// Full expected on-disk state under test/integration/, as relPath -> contents.
function expectedIntegrationFiles() {
  const files = new Map()
  for (const suite of listSuites()) {
    for (const file of listSuiteFiles(suite)) {
      const source = fs.readFileSync(path.join(desktopRoot, suite, file), 'utf8')
      files.set(`${suite}/${file}`, transformSource(suite, file, source))
    }
  }
  return files
}

function expectedEntries() {
  const entries = []
  // Two different sources can slugify to the same runner name (e.g. a future
  // `logger-teardown/test.js` collides with `logger/teardown.test.js` — both give
  // runLoggerTeardownTest). integration.auto.cjs would then declare the same
  // `async function` twice: valid JS, so the second silently wins and a test
  // disappears with no error. Fail loudly instead.
  const seen = new Map()
  for (const suite of listSuites()) {
    for (const file of listSuiteFiles(suite)) {
      if (!isTestEntry(file)) continue
      const relPath = `${suite}/${file}`
      const fnName = toFunctionName(suite, file)
      if (seen.has(fnName)) {
        throw new Error(
          `Runner name collision: '${fnName}' is produced by both ` +
            `'${seen.get(fnName)}' and '${relPath}'. Rename one of the desktop ` +
            'sources (or adjust toFunctionName) — otherwise one of those tests ' +
            'would be silently dropped from integration.auto.cjs.'
        )
      }
      seen.set(fnName, relPath)
      entries.push({ suite, file, relPath, fnName })
    }
  }
  return entries
}

function expectedAutoCjs(entries) {
  const lines = []
  lines.push("'use strict'")
  lines.push("require('./integration-runtime.cjs')")
  lines.push('')
  lines.push('// AUTO-GENERATED FILE. Run `npm run test:mobile:generate` to update.')
  lines.push('// One wrapper per desktop integration test under test/integration/.')
  lines.push('// The harness invokes these as independent on-device tests.')
  lines.push('')
  lines.push('/* global runIntegrationModule */')
  lines.push('')
  lines.push('/* global __shouldRunTest */')
  lines.push('')
  lines.push(
    "const __FILTERED = { modulePath: 'filtered', summary: { total: 0, passed: 0, failed: 0 } }"
  )
  lines.push('')

  entries.forEach((entry, index) => {
    lines.push(
      `async function ${entry.fnName} (options = {}) { // eslint-disable-line no-unused-vars`
    )
    lines.push(
      `  if (typeof __shouldRunTest === 'function' && !__shouldRunTest('${entry.fnName}')) return __FILTERED`
    )
    lines.push(`  return runIntegrationModule('../integration/${entry.relPath}', options)`)
    lines.push('}')
    if (index < entries.length - 1) lines.push('')
  })

  return `${lines.join('\n')}\n`
}

// Device Farm shard map: ONE GROUP PER DESKTOP SUITE.
//
// Why: on desktop each sub-package runs as its own process, so process-global
// state can't leak between suites. On device the harness runs every entry in ONE
// app process sharing one JsLogger singleton — and logger/worker-set-norelease.js
// deliberately never calls releaseLogger, so logger state would bleed into the
// other suites. Each group becomes a separate Device Farm run (fresh app launch,
// fresh process), which reproduces desktop's isolation exactly.
//
// Generated, not hand-written: a hand-maintained map goes stale the moment a
// desktop test is added, and in sharded mode anything absent from every group is
// silently never run.
//
// Cost: one Device Farm run per suite per platform instead of a single run.
// Device Farm bills device-minutes actually used and these suites are seconds of
// compute, so the extra runs are cheap relative to the isolation they buy.
function expectedTestGroups(entries) {
  const perSuite = {}
  for (const entry of entries) {
    if (!perSuite[entry.suite]) perSuite[entry.suite] = []
    perSuite[entry.suite].push(entry.fnName)
  }
  // Same split on both platforms; the composite reads the platform-lowercased key.
  return `${JSON.stringify({ android: perSuite, ios: perSuite }, null, 2)}\n`
}

function listOnDiskIntegrationFiles() {
  const found = new Map()
  if (!fs.existsSync(integrationDir)) return found
  for (const suite of fs.readdirSync(integrationDir)) {
    const suiteDir = path.join(integrationDir, suite)
    if (!fs.statSync(suiteDir).isDirectory()) {
      found.set(suite, fs.readFileSync(suiteDir, 'utf8'))
      continue
    }
    for (const file of fs.readdirSync(suiteDir)) {
      found.set(`${suite}/${file}`, fs.readFileSync(path.join(suiteDir, file), 'utf8'))
    }
  }
  return found
}

module.exports = {
  mobileRoot,
  desktopRoot,
  integrationDir,
  mobileDir,
  autoFile,
  groupsFile,
  listSuites,
  listSuiteFiles,
  isTestEntry,
  toFunctionName,
  transformSource,
  expectedIntegrationFiles,
  expectedEntries,
  expectedAutoCjs,
  expectedTestGroups,
  listOnDiskIntegrationFiles
}
