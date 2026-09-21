'use strict'

// Single source of truth for porting the DESKTOP suites (../../tests/integration_js/*)
// onto the mobile test addon. Nothing here — JS or C++ — is hand-written.
//
// Why port instead of reusing in place: each desktop suite is its own Bare addon
// whose tests `require('.')` their own binding, but the mobile harness is
// one-addon-per-app and only bundles files under this addon's own test/ dir.
//
// Never hand-edit generated output; change the desktop source and re-run
// `npm run test:mobile:generate`.

const fs = require('fs')
const path = require('path')

const mobileRoot = path.resolve(__dirname, '..', '..')
const desktopRoot = path.resolve(mobileRoot, '..', 'tests', 'integration_js')
const integrationDir = path.join(mobileRoot, 'test', 'integration')
const mobileDir = path.join(mobileRoot, 'test', 'mobile')
const autoFile = path.join(mobileDir, 'integration.auto.cjs')
const groupsFile = path.join(mobileDir, 'test-groups.json')

// Ported desktop bindings + the generated unified module (gitignored).
const nativeDir = path.join(mobileRoot, 'generated', 'native')
const nativeBindingFile = path.join(nativeDir, 'binding.cpp')
const nativeSourcesCmake = path.join(nativeDir, 'sources.cmake')

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

// An entry is what the harness runs as an independent on-device test. worker-*.js
// are support files the tests spawn — copied, but never entries.
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

// The files a desktop suite actually RUNS, taken from its `scripts.test` — the same
// source of truth desktop itself uses. Parsed rather than trusted blindly: see
// assertEntriesMatchDesktopScripts.
function suiteScriptFiles(suite) {
  const pkg = JSON.parse(fs.readFileSync(path.join(desktopRoot, suite, 'package.json'), 'utf8'))
  const script = (pkg.scripts || {}).test || ''
  const files = new Set()
  for (const match of script.matchAll(/\bbare\s+([^\s&|;]+)/g)) files.add(match[1])
  return { script, files }
}

// Entries are discovered by FILENAME (test.js / *.test.js), but what desktop runs is
// each suite's `scripts.test`. Those are two different rules, and the validator
// re-derives entries with the discovery rule — so it agrees with the generator by
// construction and cannot notice the two drifting apart.
//
// Concretely: add `bare cancel-flow.js` to a suite's test script and desktop runs it,
// mobile never ports it, validate passes, and the device run is green while covering
// less than it appears to. Assert the two sets are equal instead, so that becomes a
// hard failure at generate time rather than silent lost coverage.
//
// Deliberately NOT re-sourced from scripts.test: the sets agree today, and making a
// `bare <file>` parser authoritative would risk changing the entry set over edge cases
// (flags, non-bare commands, npm indirection) for no gain. This only ever fails.
function assertEntriesMatchDesktopScripts(entries) {
  const bySuite = new Map()
  for (const entry of entries) {
    if (!bySuite.has(entry.suite)) bySuite.set(entry.suite, new Set())
    bySuite.get(entry.suite).add(entry.file)
  }

  for (const suite of listSuites()) {
    const { script, files: ran } = suiteScriptFiles(suite)
    const discovered = bySuite.get(suite) || new Set()

    // No `bare <file>` at all means the suite is driven some other way, so the
    // filename rule has stopped tracking it. Fail rather than skip the suite, which
    // would recreate the same blind spot one level up.
    if (ran.size === 0) {
      throw new Error(
        `Desktop suite '${suite}' has no \`bare <file>\` invocations in its ` +
          `scripts.test (${JSON.stringify(script)}), so there is nothing to check the ` +
          'ported entries against. Update this assertion to understand how that suite ' +
          'is run before relying on the mobile port of it.'
      )
    }

    const notPorted = [...ran].filter((file) => !discovered.has(file)).sort()
    const notRun = [...discovered].filter((file) => !ran.has(file)).sort()

    if (notPorted.length) {
      throw new Error(
        `Desktop suite '${suite}' runs ${notPorted.join(', ')} in scripts.test, but ` +
          'the mobile port does not treat them as entries (they do not match ' +
          'test.js / *.test.js). They would run on desktop and NOT on device, with ' +
          'nothing reporting the gap. Rename them to the *.test.js convention, or ' +
          'extend isTestEntry.'
      )
    }
    if (notRun.length) {
      throw new Error(
        `Mobile would run ${notRun.join(', ')} from desktop suite '${suite}' as ` +
          'on-device entries, but its scripts.test does not run them. Either add them ' +
          'to the desktop test script or rename them so they are not picked up as ' +
          'entries.'
      )
    }
  }
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
  // Both the generator and the validator call expectedEntries(), so asserting here
  // means the generator itself refuses to emit a drifted set — rather than emitting it
  // and hoping a separate check notices.
  assertEntriesMatchDesktopScripts(entries)
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

// Device Farm shard map: one group per suite, because each group is a separate
// run (fresh app process) and desktop likewise runs each sub-package in its own
// process. Without it, every entry shares one process and one JsLogger singleton
// — and logger/worker-set-norelease.js never releases it, so logger state would
// bleed into the other suites.
//
// Generated, not hand-written: a stale map silently drops tests, since sharded
// mode never runs an entry that is absent from every group.
function expectedTestGroups(entries) {
  const perSuite = {}
  for (const entry of entries) {
    if (!perSuite[entry.suite]) perSuite[entry.suite] = []
    perSuite[entry.suite].push(entry.fnName)
  }
  // Same split on both platforms; the composite reads the platform-lowercased key.
  return `${JSON.stringify({ android: perSuite, ios: perSuite }, null, 2)}\n`
}

// ---------------------------------------------------------------------------
// NATIVE side: port the desktop bindings instead of hand-copying them.
// ---------------------------------------------------------------------------

const NATIVE_EXTS = new Set(['.cpp', '.hpp', '.h', '.cc', '.hh'])

const NATIVE_BANNER = [
  '// AUTO-GENERATED FROM THE DESKTOP SUITE — DO NOT EDIT.',
  '//',
  '// Source: tests/integration_js/%SUITE%/%FILE%',
  '// Regenerate: npm run test:mobile:generate',
  '%EXTRA%',
  ''
].join('\n')

function suiteIdent(suite) {
  return suite.replace(/[^a-zA-Z0-9]+/g, '_')
}

function listSuiteNativeFiles(suite) {
  return fs
    .readdirSync(path.join(desktopRoot, suite))
    .filter((name) => NATIVE_EXTS.has(path.extname(name)))
    .sort()
}

// Gives the suite's exports function external linkage under a unique name. Most
// desktop bindings wrap it in an anonymous namespace, so the unified module can't
// reach it across TUs; appending a bridge at file scope avoids rewriting
// namespaces (fragile brace surgery) to achieve the same thing.
function bridgeName(suite) {
  return `qvac_mobile_suite_exports_${suiteIdent(suite)}`
}

function transformNativeSource(suite, file, source) {
  const isBinding = file === 'binding.cpp'
  let extra = '// Copied verbatim; the unified binding.cpp owns module registration.'
  let body = source

  if (isBinding) {
    // BARE_MODULE(<module>, <exportsFn>) — capture the exports function, then drop
    // the registration: only the unified module may register itself.
    const m = source.match(/BARE_MODULE\(\s*[A-Za-z0-9_]+\s*,\s*([A-Za-z0-9_:]+)\s*\)/)
    if (!m) {
      throw new Error(
        `${suite}/${file}: no BARE_MODULE(...) found — cannot determine the ` +
          "suite's exports function. Did the desktop binding change shape?"
      )
    }
    const exportsFn = m[1]
    body = source.replace(/BARE_MODULE\(\s*[A-Za-z0-9_]+\s*,\s*[A-Za-z0-9_:]+\s*\)\s*/, '')
    body =
      `${body.replace(/\s*$/, '')}\n\n` +
      `// External-linkage bridge to ${exportsFn} (see desktop-suites.js).\n` +
      `js_value_t* ${bridgeName(suite)}(js_env_t* env, js_value_t* exports) {\n` +
      `  return ${exportsFn}(env, exports);\n` +
      '}\n'
    extra =
      '// Mechanical changes: BARE_MODULE(...) dropped (the unified binding.cpp\n' +
      `// registers the module), and a bridge '${bridgeName(suite)}' appended so the\n` +
      "// suite's exports function is reachable from another translation unit."
  }

  const banner = NATIVE_BANNER.replace('%SUITE%', suite)
    .replace('%FILE%', file)
    .replace('%EXTRA%', extra)
  return `${banner}${body}`
}

// relPath (`<suite>/<file>`) -> contents, mirroring the desktop layout so quoted
// includes like "test_logger.hpp" keep resolving next to their binding.
function expectedNativeFiles() {
  const files = new Map()
  for (const suite of listSuites()) {
    for (const file of listSuiteNativeFiles(suite)) {
      const source = fs.readFileSync(path.join(desktopRoot, suite, file), 'utf8')
      files.set(`${suite}/${file}`, transformNativeSource(suite, file, source))
    }
  }
  return files
}

// The one module registration: calls each suite's bridge against the SAME
// exports object, so every suite's own exports function installs its own names
// (and any module-init side effects it performs, e.g. output-callback-lifetime
// recording the JS thread id, happen exactly as they do on desktop).
function expectedNativeBinding() {
  const suites = listSuites()
  const lines = []
  lines.push('// AUTO-GENERATED — DO NOT EDIT. Run `npm run test:mobile:generate`.')
  lines.push('//')
  lines.push('// Unified Bare module for the on-device integration tests. The mobile harness')
  lines.push('// is one-addon-per-app, so the desktop suites are aggregated into this single')
  lines.push('// module; each suite installs its own exports via its generated bridge.')
  lines.push('')
  lines.push('#include <bare.h>')
  lines.push('#include <js.h>')
  lines.push('')
  for (const suite of suites) {
    lines.push(`// tests/integration_js/${suite}`)
    lines.push(`js_value_t* ${bridgeName(suite)}(js_env_t* env, js_value_t* exports);`)
  }
  lines.push('')
  lines.push('static js_value_t* inferenceAddonCppMobileTestsExports(')
  lines.push('    js_env_t* env,')
  lines.push('    js_value_t* exports) {')
  for (const suite of suites) {
    lines.push(`  if (${bridgeName(suite)}(env, exports) == nullptr) {`)
    lines.push('    return nullptr;')
    lines.push('  }')
  }
  lines.push('  return exports;')
  lines.push('}')
  lines.push('')
  lines.push('BARE_MODULE(inference_addon_cpp_mobile_tests, inferenceAddonCppMobileTestsExports)')
  return `${lines.join('\n')}\n`
}

// CMake can't glob reliably at configure time for files that may not exist yet,
// so the generator emits the source list it just produced.
function expectedNativeSourcesCmake() {
  const rel = ['binding.cpp']
  for (const key of expectedNativeFiles().keys()) {
    if (key.endsWith('.cpp') || key.endsWith('.cc')) rel.push(key)
  }
  const lines = []
  lines.push('# AUTO-GENERATED — DO NOT EDIT. Run `npm run test:mobile:generate`.')
  lines.push('set(QVAC_MOBILE_GENERATED_SOURCES')
  for (const r of rel) lines.push(`  \${CMAKE_CURRENT_LIST_DIR}/${r}`)
  lines.push(')')
  return `${lines.join('\n')}\n`
}

function listOnDiskNativeFiles() {
  const found = new Map()
  if (!fs.existsSync(nativeDir)) return found
  for (const entry of fs.readdirSync(nativeDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    for (const file of fs.readdirSync(path.join(nativeDir, entry.name))) {
      found.set(
        `${entry.name}/${file}`,
        fs.readFileSync(path.join(nativeDir, entry.name, file), 'utf8')
      )
    }
  }
  return found
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
  nativeDir,
  nativeBindingFile,
  nativeSourcesCmake,
  expectedNativeFiles,
  expectedNativeBinding,
  expectedNativeSourcesCmake,
  listOnDiskNativeFiles,
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
