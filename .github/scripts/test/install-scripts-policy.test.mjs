// Guards that CI never runs dependency lifecycle scripts on an npm install.
//
// Scope: npm only. Global `npm install -g` tooling installs need pinning rather
// than this flag. bun runs postinstall only for its own trusted list, and the
// one pnpm site already passes the flag.
//
// Parsed as text on purpose: the `policy-tests` job runs `node --test` with no
// npm install, so no YAML library is available. Same approach as
// ci-trust-policy.test.mjs and publish-gate-policy.test.mjs.
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')
const SCAN_ROOTS = ['.github/workflows', '.github/actions', 'scripts']
const SCAN_EXTENSIONS = ['.yml', '.yaml', '.sh', '.mjs', '.cjs']

// package.json scripts are scanned too: a workflow step can read as
// `npm run <script>` while the install itself lives in the manifest, which
// would otherwise sit outside the policy entirely.
const MANIFEST_ROOTS = ['packages', 'plugins']

// Sites that legitimately run install scripts. `count` is how many sites the
// entry covers, so an exemption cannot silently absorb a new install added to
// the same file, and a removed site fails instead of leaving a dead entry.
const ALLOWED = [
  {
    file: 'scripts/ci/openclaw-upstream-compat-smoke.sh',
    match: 'npm install --no-fund --no-audit',
    count: 1,
    reason:
      'Installs published openclaw to test it. Its postinstall-bundled-plugins hook, plus the koffi and tree-sitter-bash native builds, are what the smoke measures. The job runs contents:read with persist-credentials:false and no token in .npmrc.',
  },
  {
    file: 'scripts/ci/opencode-upstream-compat-smoke.sh',
    match: 'npm install --no-fund --no-audit',
    count: 1,
    reason:
      "Installs published opencode-ai to test it; its postinstall.mjs is what the smoke measures. Job runs contents:read with persist-credentials:false and no token in .npmrc.",
  },
  ...[
    ['.github/workflows/test-android-sdk.yml', 2],
    ['.github/workflows/test-ios-sdk.yml', 2],
    ['.github/workflows/test-node-sdk.yml', 1],
  ].map(([file, count]) => ({
    file,
    match: 'npm install --install-links',
    count,
    reason:
      'packages/sdk/e2e consumer depends on electron and react-native, both of which install through postinstall.',
  })),
  {
    file: '.github/actions/run-mobile-integration-tests/build-mobile-app/action.yml',
    match: 'npm install',
    count: 2,
    reason:
      'Expo app from tetherto/qvac-test-addon-mobile; its React Native toolchain installs through postinstall.',
  },
  {
    file: '.github/actions/run-mobile-integration-tests/upload-to-devicefarm/action.yml',
    match: 'npm install',
    count: 1,
    reason: 'Device Farm e2e bundle for the same Expo app.',
  },
  {
    file: '.github/actions/run-mobile-integration-tests/upload-to-devicefarm/generate-testspec.sh',
    match: 'npm install --legacy-peer-deps',
    count: 1,
    reason: 'Runs on the Device Farm host, inside the same Expo app.',
  },
  {
    file: '.github/workflows/pr-checks-sdk-pod.yml',
    match: '"$PM" install',
    count: 1,
    reason:
      'Reached only when $PM is bun (ai-sdk-provider); the npm branch above passes the flag explicitly. Kept detectable so a revert to the $PM indirection for npm is caught.',
  },
  {
    file: 'packages/sdk/e2e/package.json',
    match: '"install:build"',
    count: 1,
    reason:
      'Same consumer tree as the SDK e2e workflow installs: electron and react-native both install through postinstall.',
  },
  ...[
    'packages/cli/package.json',
    'plugins/openclaw/package.json',
    'plugins/opencode/package.json',
  ].map((file) => ({
    file,
    match: '"dev:link"',
    count: 1,
    reason: 'Developer convenience for linking siblings locally; no CI lane runs it.',
  })),
  ...['packages/llm-llamacpp/package.json', 'packages/embed-llamacpp/package.json'].map(
    (file) => ({
      file,
      match: '"quickstart"',
      count: 1,
      reason:
        "Documented command for consumers; the install fetches the published addon onto the reader's machine, not in CI.",
    }),
  ),
]

// Sites still to migrate, tracked on QVAC-25458. This list only shrinks; adding
// to it needs the same review as removing the flag would.
const PENDING = [
  // PR 2 — addon lanes. cpp-lint rides run_verified_checks, which any authorized
  // non-draft PR gets; the cpp-tests and integration legs need the
  // run-cpp-addon-tests and run-desktop-addon-tests labels.
  ...[
    ['.github/workflows/cpp-lint.yaml', 1],
    ['.github/workflows/cpp-test-coverage-asr-ggml.yml', 1],
    ['.github/workflows/cpp-test-coverage-bci-whispercpp.yml', 1],
    ['.github/workflows/cpp-test-coverage-tts-ggml.yml', 1],
    ['.github/workflows/cpp-tests-llm.yml', 1],
    ['.github/workflows/cpp-tests-model-fit.yml', 1],
    ['.github/workflows/cpp-tests-nx.yml', 2],
    ['.github/workflows/cpp-tests-vla.yml', 1],
    ['.github/workflows/integration-mobile-test-inference-addon-cpp.yml', 3],
    ['.github/workflows/integration-test-asr-ggml.yml', 1],
    ['.github/workflows/integration-test-audiogen-ggml.yml', 1],
    ['.github/workflows/integration-test-llm-llamacpp.yml', 1],
    ['.github/workflows/integration-test-vla.yml', 1],
    ['.github/workflows/reusable-cpp-tests-translation-nmtcpp.yml', 1],
    ['.github/workflows/reusable-prebuilds.yml', 1],
    ['.github/actions/cpp-lint/action.yaml', 1],
  ].map(([file, count]) => ({
    file,
    match: 'npm install',
    count,
    reason: 'QVAC-25458 PR 2',
  })),

  // PR 3 — registry-server, the shared lint composites, remaining SDK lanes.
  ...[
    ['.github/workflows/fill-fit-blobs-registry-server.yml', 1],
    ['.github/workflows/on-merge-model-cache-audiogen.yml', 1],
    ['.github/workflows/pr-models-validation-registry-server.yml', 7],
    ['.github/workflows/publish-registry-server.yml', 1],
    ['.github/workflows/test-sdk.yml', 1],
    ['.github/workflows/trigger-reusable-lib.yml', 1],
    ['.github/actions/run-lint-and-integration-tests/action.yaml', 1],
    ['.github/actions/run-lint-and-unit-tests/action.yaml', 1],
  ].map(([file, count]) => ({
    file,
    match: 'npm install',
    count,
    reason: 'QVAC-25458 PR 3',
  })),
  {
    file: '.github/workflows/on-pr-test-sdk.yml',
    match: 'npm install --no-save',
    count: 1,
    reason: 'QVAC-25458 PR 3',
  },

  // PR 4 — dispatch-only benchmark lanes; each needs a manual run to verify.
  ...[
    ['.github/workflows/benchmark-asr-ggml.yml', 3],
    ['.github/workflows/benchmark-embed-llamacpp.yml', 2],
    ['.github/workflows/benchmark-llm-llamacpp.yml', 2],
    ['.github/workflows/benchmark-ocr-ggml.yml', 2],
    ['.github/workflows/benchmark-perf-embed-llamacpp.yml', 2],
    ['.github/workflows/benchmark-perf-llm-llamacpp.yml', 2],
    ['.github/workflows/benchmark-translation-nmtcpp.yml', 2],
    ['.github/workflows/benchmark-vlm-model-comparison.yml', 1],
  ].map(([file, count]) => ({
    file,
    match: 'npm install',
    count,
    reason: 'QVAC-25458 PR 4',
  })),
  {
    file: 'packages/bci-whispercpp/package.json',
    match: '"test:mobile:generate"',
    count: 1,
    reason: 'QVAC-25458 PR 4 — run by the integration-mobile-test-* lanes',
  },
  {
    file: 'packages/embed-llamacpp/package.json',
    match: '"performance:install"',
    count: 1,
    reason: 'QVAC-25458 PR 4 — benchmark helper, no CI caller today',
  },
]

function filesUnder(directory) {
  let entries
  try {
    entries = readdirSync(join(root, directory), { withFileTypes: true })
  } catch {
    return []
  }
  return entries.flatMap((entry) => {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) return filesUnder(path)
    return SCAN_EXTENSIONS.some((ext) => path.endsWith(ext)) ? [path] : []
  })
}

// Joins backslash continuations so a flag on a later line still counts, and
// keeps the first physical line number for the report.
function logicalLines(source) {
  const out = []
  const lines = source.split('\n')
  for (let i = 0; i < lines.length; i += 1) {
    let text = lines[i]
    const start = i + 1
    while (text.trimEnd().endsWith('\\') && i + 1 < lines.length) {
      text = text.trimEnd().slice(0, -1) + ' ' + lines[i + 1].trim()
      i += 1
    }
    out.push({ line: start, text })
  }
  return out
}

// `"$PM" install` in pr-checks-sdk-pod.yml is a real site a plain npm regex
// misses; $PM defaults to npm in .github/sdk-pod-checks.json.
// `install` before `i` so the longer form wins; `\b` keeps `i` off `init`.
const INSTALL = /(?:\bnpm\s+(?:install|ci|add|i)\b)|(?:"\$PM"\s+install\b)/
const GLOBAL = /\s-g\b|--global\b/

// Only count a match that sits where a command can start. Prose in a YAML
// block scalar, an inline `#` comment and a quoted step label all mention
// `npm install` without running it, and each of those has text in front of the
// match that no shell would accept.
const COMMAND_POSITION = new RegExp(
  '^' +
    '\\s*(?:-\\s+)?' + // YAML sequence item
    '(?:run:\\s*(?:[|>][-+]?\\s*)?)?' + // `run:` and its block-scalar header
    '(?:run\\s+"[^"]*"\\s+)?' + // the `run "<label>" <cmd>` helper in pr-checks-sdk-pod
    '(?:if\\s+)?(?:!\\s*)?' + // `if ! npm install ...`
    '(?:.*(?:&&|\\|\\||;|\\bthen\\b|\\bdo\\b|\\belse\\b)\\s*)?' + // chained after another command
    '$',
)

function isCommand(text, matchIndex) {
  const prefix = text.slice(0, matchIndex)
  if (prefix.includes('#')) return false
  return COMMAND_POSITION.test(prefix)
}

// A `run:` built from a GitHub expression picks one quoted arm per matrix leg,
// so each arm is its own command and has to carry the flag on its own. Reading
// the whole line would let one flagged arm cover an unflagged sibling.
function expressionArms(text) {
  if (!text.includes('${{')) return []
  return [...text.matchAll(/'([^']*)'/g)]
    .map((match) => match[1])
    .filter((arm) => INSTALL.test(arm))
}

function scanSource(file, source, sites) {
  for (const { line, text } of logicalLines(source)) {
    const arms = expressionArms(text)
    if (arms.length > 0) {
      for (const arm of arms) {
        if (GLOBAL.test(arm)) continue
        sites.push({
          file,
          line,
          text: arm.trim(),
          ignoresScripts: /--ignore-scripts/.test(arm),
        })
      }
      continue
    }

    const match = INSTALL.exec(text)
    if (match === null) continue
    if (GLOBAL.test(text)) continue
    if (!isCommand(text, match.index)) continue
    sites.push({
      file,
      line,
      text: text.trim(),
      ignoresScripts: /--ignore-scripts/.test(text),
    })
  }
}

function manifestsUnder(directory) {
  let entries
  try {
    entries = readdirSync(join(root, directory), { withFileTypes: true })
  } catch {
    return []
  }
  return entries.flatMap((entry) => {
    if (entry.name === 'node_modules') return []
    const path = join(directory, entry.name)
    if (entry.isDirectory()) return manifestsUnder(path)
    return entry.name === 'package.json' ? [path] : []
  })
}

function scanManifest(file, source, sites) {
  let scripts
  try {
    scripts = JSON.parse(source).scripts ?? {}
  } catch {
    return
  }
  for (const [name, command] of Object.entries(scripts)) {
    if (typeof command !== 'string') continue
    if (!INSTALL.test(command) || GLOBAL.test(command)) continue
    const needle = `"${name}"`
    const index = source.indexOf(needle)
    sites.push({
      file,
      line: index === -1 ? 0 : source.slice(0, index).split('\n').length,
      text: `${needle}: ${command}`,
      ignoresScripts: /--ignore-scripts/.test(command),
    })
  }
}

function installSites() {
  const sites = []
  for (const directory of SCAN_ROOTS) {
    for (const file of filesUnder(directory)) {
      // These assert on workflow text; their own mentions are not commands.
      if (file.startsWith(join('.github', 'scripts', 'test'))) continue
      scanSource(
        file.split('\\').join('/'),
        readFileSync(join(root, file), 'utf8'),
        sites,
      )
    }
  }
  for (const directory of MANIFEST_ROOTS) {
    for (const file of manifestsUnder(directory)) {
      scanManifest(
        file.split('\\').join('/'),
        readFileSync(join(root, file), 'utf8'),
        sites,
      )
    }
  }
  return sites
}

function exemptionFor(site) {
  return [...ALLOWED, ...PENDING].find(
    (entry) => entry.file === site.file && site.text.includes(entry.match),
  )
}

test('every npm install in CI disables dependency lifecycle scripts', () => {
  const offenders = installSites()
    .filter((site) => !site.ignoresScripts)
    .filter((site) => exemptionFor(site) === undefined)
    .map((site) => `${site.file}:${site.line}  ${site.text}`)

  assert.deepEqual(
    offenders,
    [],
    `npm install without --ignore-scripts. Add the flag, or add an ALLOWED entry with the reason the site needs lifecycle scripts:\n  ${offenders.join('\n  ')}`,
  )
})

test('each exemption covers exactly the sites it declares', () => {
  const sites = installSites()
  const drifted = [...ALLOWED, ...PENDING]
    .map((entry) => ({
      entry,
      found: sites.filter(
        (site) => site.file === entry.file && site.text.includes(entry.match),
      ).length,
    }))
    .filter(({ entry, found }) => found !== entry.count)
    .map(
      ({ entry, found }) =>
        `${entry.file}  (match: ${entry.match})  declared ${entry.count}, found ${found}`,
    )

  assert.deepEqual(
    drifted,
    [],
    `Exemption count drifted. A new install in an exempt file needs the flag or its own entry; a removed one must shrink the count:\n  ${drifted.join('\n  ')}`,
  )
})

test('the scan sees the sites it is meant to police', () => {
  const sites = installSites()
  const files = new Set(sites.map((site) => site.file))

  // Canaries: if a rewrite of the detector stops seeing these, the suite would
  // pass by finding nothing at all.
  for (const expected of [
    '.github/workflows/trigger-reusable-lib-cli.yml',
    '.github/workflows/pr-checks-sdk-pod.yml',
    'scripts/ci/openclaw-upstream-compat-smoke.sh',
    'packages/cli/package.json',
  ]) {
    assert.ok(files.has(expected), `detector found no install site in ${expected}`)
  }

  assert.ok(
    sites.some((site) => site.text.includes('"$PM" install')),
    'detector no longer sees the $PM indirection in pr-checks-sdk-pod.yml',
  )

  // The cli build job runs `npm run sdk-source:workspace`, whose install lives
  // in the manifest rather than the workflow.
  assert.ok(
    sites.some(
      (site) =>
        site.file === 'packages/cli/package.json' &&
        site.text.includes('"sdk-source:workspace"'),
    ),
    'detector no longer sees installs inside package.json scripts',
  )

  // Both arms of an expression-built `run:` must be separate sites, or one
  // flagged arm hides an unflagged sibling.
  const nxArms = sites.filter(
    (site) => site.file === '.github/workflows/cpp-tests-nx.yml',
  )
  assert.equal(nxArms.length, 2, 'expected both expression arms in cpp-tests-nx.yml')
  assert.equal(
    nxArms.filter((site) => site.ignoresScripts).length,
    1,
    'expected exactly one flagged arm in cpp-tests-nx.yml',
  )
})
