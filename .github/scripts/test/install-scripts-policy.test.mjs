// Guards that CI never runs dependency lifecycle scripts on an npm install.
//
// QVAC-25458: a bare `npm install` executes preinstall/install/postinstall for
// every package in the resolved tree, including ones the build never imports.
// No package under packages/ or plugins/ has a lockfile — packages/*/package-
// lock.json is gitignored — so each run re-resolves floating ^ ranges from the
// registry and runs whatever it gets. Several of those jobs write GITHUB_TOKEN
// into the workspace .npmrc immediately before installing, and some also carry
// NPM_TOKEN or AWS credentials.
//
// The workspace already takes this position on the pnpm side: pnpm-workspace
// .yaml denies build scripts by default and allowlists four packages
// (allowBuilds), sets blockExoticSubdeps, and resolves against a committed
// pnpm-lock.yaml. The npm lanes predate that and bypass all of it. Until they
// move onto `pnpm install --frozen-lockfile` this test holds the line.
//
// Scope: npm only. Global `npm install -g` tooling installs are a separate
// concern (they need pinning, not this flag). bun runs postinstall only for its
// own trusted list, and the one pnpm site already passes the flag.
//
// Parsed as text on purpose: the `policy-tests` job runs `node --test` with no
// npm install, so no YAML library is available. Same approach as
// ci-trust-policy.test.mjs and publish-gate-policy.test.mjs.
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')
const SCAN_ROOTS = ['.github/workflows', '.github/actions', 'scripts']
const SCAN_EXTENSIONS = ['.yml', '.yaml', '.sh', '.mjs', '.cjs']

// Sites that legitimately run install scripts. Every entry must still match a
// real site, so a stale one fails rather than quietly widening the policy.
const ALLOWED = [
  {
    file: 'scripts/ci/openclaw-upstream-compat-smoke.sh',
    match: 'npm install --no-fund --no-audit',
    reason:
      'Installs published openclaw to test it. Its postinstall-bundled-plugins hook, plus the koffi and tree-sitter-bash native builds, are what the smoke measures. The job runs contents:read with persist-credentials:false and no token in .npmrc.',
  },
  {
    file: 'scripts/ci/opencode-upstream-compat-smoke.sh',
    match: 'npm install --no-fund --no-audit',
    reason:
      "Installs published opencode-ai to test it; its postinstall.mjs is what the smoke measures. Job runs contents:read with persist-credentials:false and no token in .npmrc.",
  },
  {
    file: '.github/workflows/test-android-sdk.yml',
    match: 'npm install --install-links',
    reason:
      'packages/sdk/e2e consumer depends on electron and react-native, both of which install through postinstall.',
  },
  {
    file: '.github/workflows/test-ios-sdk.yml',
    match: 'npm install --install-links',
    reason:
      'packages/sdk/e2e consumer depends on electron and react-native, both of which install through postinstall.',
  },
  {
    file: '.github/workflows/test-node-sdk.yml',
    match: 'npm install --install-links',
    reason:
      'packages/sdk/e2e consumer depends on electron and react-native, both of which install through postinstall.',
  },
  {
    file: '.github/actions/run-mobile-integration-tests/build-mobile-app/action.yml',
    match: 'npm install',
    reason:
      'Expo app from tetherto/qvac-test-addon-mobile; its React Native toolchain installs through postinstall.',
  },
  {
    file: '.github/actions/run-mobile-integration-tests/upload-to-devicefarm/action.yml',
    match: 'npm install',
    reason: 'Device Farm e2e bundle for the same Expo app.',
  },
  {
    file: '.github/actions/run-mobile-integration-tests/upload-to-devicefarm/generate-testspec.sh',
    match: 'npm install --legacy-peer-deps',
    reason: 'Runs on the Device Farm host, inside the same Expo app.',
  },
  {
    file: '.github/workflows/pr-checks-sdk-pod.yml',
    match: '"$PM" install',
    reason:
      'Reached only when $PM is bun (inference, ai-sdk-provider); the npm branch above passes the flag explicitly. Kept detectable so a revert to the $PM indirection for npm is caught.',
  },
]

// Sites still to migrate, tracked on QVAC-25458. This list only shrinks; adding
// to it needs the same review as removing the flag would.
const PENDING = [
  // PR 2 — addon lanes. Verified with the `verify` label on an addon PR.
  ...[
    '.github/workflows/cpp-lint.yaml',
    '.github/workflows/cpp-test-coverage-asr-ggml.yml',
    '.github/workflows/cpp-test-coverage-bci-whispercpp.yml',
    '.github/workflows/cpp-test-coverage-tts-ggml.yml',
    '.github/workflows/cpp-tests-diffusion.yml',
    '.github/workflows/cpp-tests-embed.yml',
    '.github/workflows/cpp-tests-llm.yml',
    '.github/workflows/cpp-tests-model-fit.yml',
    '.github/workflows/cpp-tests-vla.yml',
    '.github/workflows/integration-mobile-test-inference-addon-cpp.yml',
    '.github/workflows/integration-test-asr-ggml.yml',
    '.github/workflows/integration-test-audiogen-ggml.yml',
    '.github/workflows/integration-test-bci-whispercpp.yml',
    '.github/workflows/integration-test-decoder-audio.yml',
    '.github/workflows/integration-test-diffusion-cpp.yml',
    '.github/workflows/integration-test-embed-llamacpp.yml',
    '.github/workflows/integration-test-llm-llamacpp.yml',
    '.github/workflows/integration-test-model-fit.yml',
    '.github/workflows/integration-test-ocr-ggml.yml',
    '.github/workflows/integration-test-translation-nmtcpp.yml',
    '.github/workflows/integration-test-tts-ggml.yml',
    '.github/workflows/integration-test-vla.yml',
    '.github/workflows/reusable-cpp-tests-translation-nmtcpp.yml',
    '.github/workflows/reusable-prebuilds.yml',
    '.github/actions/cpp-lint/action.yaml',
  ].map((file) => ({ file, match: 'npm install', reason: 'QVAC-25458 PR 2' })),

  // PR 3 — registry-server, the shared lint composites, remaining SDK lanes.
  ...[
    '.github/workflows/fill-fit-blobs-registry-server.yml',
    '.github/workflows/on-merge-model-cache-audiogen.yml',
    '.github/workflows/pr-models-validation-registry-server.yml',
    '.github/workflows/publish-registry-server.yml',
    '.github/workflows/test-sdk.yml',
    '.github/workflows/trigger-reusable-lib.yml',
    '.github/actions/run-lint-and-integration-tests/action.yaml',
    '.github/actions/run-lint-and-unit-tests/action.yaml',
  ].map((file) => ({ file, match: 'npm install', reason: 'QVAC-25458 PR 3' })),
  {
    file: '.github/workflows/on-pr-test-sdk.yml',
    match: 'npm install --no-save',
    reason: 'QVAC-25458 PR 3',
  },

  // PR 4 — dispatch-only benchmark lanes; each needs a manual run to verify.
  ...[
    '.github/workflows/benchmark-asr-ggml.yml',
    '.github/workflows/benchmark-embed-llamacpp.yml',
    '.github/workflows/benchmark-llm-llamacpp.yml',
    '.github/workflows/benchmark-ocr-ggml.yml',
    '.github/workflows/benchmark-perf-embed-llamacpp.yml',
    '.github/workflows/benchmark-perf-llm-llamacpp.yml',
    '.github/workflows/benchmark-translation-nmtcpp.yml',
    '.github/workflows/benchmark-vlm-model-comparison.yml',
  ].map((file) => ({ file, match: 'npm install', reason: 'QVAC-25458 PR 4' })),
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
const INSTALL = /(?:\bnpm\s+(?:install|ci)\b)|(?:"\$PM"\s+install\b)/
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

function installSites() {
  const sites = []
  for (const directory of SCAN_ROOTS) {
    for (const file of filesUnder(directory)) {
      // These assert on workflow text; their own mentions are not commands.
      if (file.startsWith(join('.github', 'scripts', 'test'))) continue
      const source = readFileSync(join(root, file), 'utf8')
      for (const { line, text } of logicalLines(source)) {
        const match = INSTALL.exec(text)
        if (match === null) continue
        if (GLOBAL.test(text)) continue
        if (!isCommand(text, match.index)) continue
        sites.push({
          file: file.split('\\').join('/'),
          line,
          text: text.trim(),
          ignoresScripts: /--ignore-scripts/.test(text),
        })
      }
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

test('no exemption outlives the site it covers', () => {
  const sites = installSites()
  const stale = [...ALLOWED, ...PENDING]
    .filter(
      (entry) =>
        !sites.some(
          (site) => site.file === entry.file && site.text.includes(entry.match),
        ),
    )
    .map((entry) => `${entry.file}  (match: ${entry.match})`)

  assert.deepEqual(
    stale,
    [],
    `Exemption no longer matches any install site — delete it:\n  ${stale.join('\n  ')}`,
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
  ]) {
    assert.ok(files.has(expected), `detector found no install site in ${expected}`)
  }

  assert.ok(
    sites.some((site) => site.text.includes('"$PM" install')),
    'detector no longer sees the $PM indirection in pr-checks-sdk-pod.yml',
  )
})
