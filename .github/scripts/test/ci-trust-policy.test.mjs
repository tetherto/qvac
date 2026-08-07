import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')
const MILLISECONDS_PER_MINUTE = 60_000

function read(relativePath) {
  return readFileSync(join(root, relativePath), 'utf8')
}

function filesUnder(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name)
    return entry.isDirectory() ? filesUnder(path) : [path]
  })
}

function extractRunBlock(relativePath, stepName) {
  const source = read(relativePath)
  const stepIndex = source.indexOf(`name: ${stepName}`)
  assert.notEqual(stepIndex, -1, `step "${stepName}" exists in ${relativePath}`)

  const remainder = source.slice(stepIndex)
  const runMatch = remainder.match(/^(\s*)run:\s*\|\s*$/m)
  assert.ok(runMatch, `run block exists after "${stepName}" in ${relativePath}`)

  const runStart = stepIndex + runMatch.index + runMatch[0].length + 1
  const contentIndent = runMatch[1].length + 2
  const lines = source.slice(runStart).split('\n')
  const block = []

  for (const line of lines) {
    if (line === '') {
      block.push('')
      continue
    }
    if (line.startsWith(' '.repeat(contentIndent))) {
      block.push(line.slice(contentIndent))
      continue
    }
    break
  }

  return block.join('\n')
}

function runScript(script, env = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'qvac-ci-policy-'))
  const outputPath = join(directory, 'github-output')
  const result = spawnSync(
    'bash',
    ['--noprofile', '--norc', '-e', '-o', 'pipefail', '-c', script],
    {
      encoding: 'utf8',
      env: {
        ...process.env,
        GITHUB_OUTPUT: outputPath,
        ...env,
      },
    },
  )

  let output = ''
  try {
    output = readFileSync(outputPath, 'utf8')
  } catch {
    // A denied/failing script can legitimately produce no output.
  }
  rmSync(directory, { recursive: true, force: true })

  assert.equal(
    result.status,
    0,
    `script failed:\nstdout=${result.stdout}\nstderr=${result.stderr}`,
  )

  return Object.fromEntries(
    output
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        const separator = line.indexOf('=')
        return [line.slice(0, separator), line.slice(separator + 1)]
      }),
  )
}

const falseRoute = {
  run_verified_checks: 'false',
  run_prebuilds: 'false',
  run_cpp_tests: 'false',
  run_desktop: 'false',
  run_mobile: 'false',
  run_coload: 'false',
}

const baselineRoute = {
  ...falseRoute,
  run_verified_checks: 'true',
}

function route(overrides = {}) {
  const script = extractRunBlock(
    '.github/actions/ci-router/action.yml',
    'Route CI stages',
  )
  return runScript(script, {
    EVENT_NAME: 'pull_request_target',
    PR_LABELS_JSON: '[]',
    HEAD_REPO: 'tetherto/qvac',
    BASE_REPO: 'tetherto/qvac',
    IS_DRAFT: 'false',
    ...overrides,
  })
}

test('ci-router: trusted non-PR events enable every stage', () => {
  assert.deepEqual(
    route({ EVENT_NAME: 'workflow_dispatch', HEAD_REPO: '', IS_DRAFT: '' }),
    {
      run_verified_checks: 'true',
      run_prebuilds: 'true',
      run_cpp_tests: 'true',
      run_desktop: 'true',
      run_mobile: 'true',
      run_coload: 'true',
    },
  )
})

test('ci-router: ready internal PR runs baseline without verified', () => {
  assert.deepEqual(route(), baselineRoute)
})

test('ci-router: internal draft runs nothing even with every heavy label', () => {
  assert.deepEqual(
    route({
      IS_DRAFT: 'true',
      PR_LABELS_JSON: JSON.stringify([
        'prebuilds',
        'run-cpp-addon-tests',
        'run-desktop-addon-tests',
        'run-mobile-addon-tests',
      ]),
    }),
    falseRoute,
  )
})

test('ci-router: internal granular labels select only requested stages', () => {
  assert.deepEqual(
    route({ PR_LABELS_JSON: '["run-cpp-addon-tests"]' }),
    { ...baselineRoute, run_cpp_tests: 'true' },
  )
  assert.deepEqual(
    route({ PR_LABELS_JSON: '["run-desktop-addon-tests"]' }),
    {
      ...baselineRoute,
      run_prebuilds: 'true',
      run_desktop: 'true',
    },
  )
  assert.deepEqual(
    route({ PR_LABELS_JSON: '["run-mobile-addon-tests"]' }),
    {
      ...baselineRoute,
      run_prebuilds: 'true',
      run_mobile: 'true',
    },
  )
})

test('ci-router: run-coload-tests selects the co-load stage and its prebuild', () => {
  // The co-load overlays the PR's freshly-built prebuild, so the label pulls in
  // run_prebuilds too. The Device Farm leg keys off run_mobile, so the co-load
  // label alone is the cheap desktop co-load.
  assert.deepEqual(
    route({ PR_LABELS_JSON: '["run-coload-tests"]' }),
    {
      ...baselineRoute,
      run_prebuilds: 'true',
      run_coload: 'true',
    },
  )
})

test('ci-router: external fork ready PR gets baseline routing without verified label', () => {
  assert.deepEqual(route({ HEAD_REPO: 'outsider/qvac' }), baselineRoute)
  assert.deepEqual(
    route({
      HEAD_REPO: 'outsider/qvac',
      PR_LABELS_JSON: '["run-mobile-addon-tests"]',
    }),
    {
      ...baselineRoute,
      run_prebuilds: 'true',
      run_mobile: 'true',
    },
  )
})

test('ci-router: external fork draft runs nothing even with heavy labels', () => {
  assert.deepEqual(
    route({
      HEAD_REPO: 'outsider/qvac',
      IS_DRAFT: 'true',
      PR_LABELS_JSON: '["run-coload-tests"]',
    }),
    falseRoute,
  )
})

test('ci-router: missing head repo fails closed; fork and same-repo route alike', () => {
  assert.deepEqual(route({ HEAD_REPO: '' }), falseRoute)
  // Routing is not a trust decision, so a fork and a same-repo PR get the same
  // stages. Fork trust lives in `needs: fork-approval` (asserted further down).
  assert.deepEqual(route({ HEAD_REPO: 'TetherTo/QVAC' }), baselineRoute)
  assert.deepEqual(route({ HEAD_REPO: 'outsider/qvac' }), baselineRoute)
})

function inferenceAuthorization(relativePath, stepName, overrides = {}) {
  const script = extractRunBlock(relativePath, stepName)
  return runScript(script, {
    EVENT: 'pull_request',
    IS_FORK: 'false',
    IS_DRAFT: 'false',
    HAS_RUN_LABEL: 'false',
    // SHA-bound approval (qvac/fork-verified status on the current head),
    // resolved by the job's separate read-only step; injected here for the
    // decision-logic unit.
    HAS_APPROVED_SHA: 'false',
    ...overrides,
  })
}

for (const [relativePath, stepName, label, runLabel] of [
  [
    '.github/workflows/pr-test-inference-addon-cpp.yml',
    'Authorize native tests',
    'native',
    'run-cpp-addon-tests',
  ],
  [
    '.github/workflows/pr-test-inference-addon-cpp-js.yml',
    'Authorize JS tests',
    'JS',
    'run-desktop-addon-tests',
  ],
]) {
  test(`${label} authorization: internal ready PR needs only ${runLabel}`, () => {
    assert.equal(
      inferenceAuthorization(relativePath, stepName).allowed,
      'false',
    )
    assert.equal(
      inferenceAuthorization(relativePath, stepName, {
        HAS_RUN_LABEL: 'true',
      }).allowed,
      'true',
    )
  })

  test(`${label} authorization: drafts are denied until ready`, () => {
    assert.equal(
      inferenceAuthorization(relativePath, stepName, {
        IS_DRAFT: 'true',
        HAS_RUN_LABEL: 'true',
      }).allowed,
      'false',
    )
  })

  test(`${label} authorization: external fork needs ${runLabel} AND a SHA-bound approval`, () => {
    // Fork, nothing -> denied.
    assert.equal(
      inferenceAuthorization(relativePath, stepName, { IS_FORK: 'true' })
        .allowed,
      'false',
    )
    // Approved SHA but no tier label -> denied.
    assert.equal(
      inferenceAuthorization(relativePath, stepName, {
        IS_FORK: 'true',
        HAS_APPROVED_SHA: 'true',
      }).allowed,
      'false',
    )
    // Tier label present but the current head SHA is NOT approved (stale label /
    // draft->ready / close->reopen flip / fresh push) -> denied.
    assert.equal(
      inferenceAuthorization(relativePath, stepName, {
        IS_FORK: 'true',
        HAS_RUN_LABEL: 'true',
      }).allowed,
      'false',
    )
    // Tier label + SHA-bound approval on the current head -> allowed.
    assert.equal(
      inferenceAuthorization(relativePath, stepName, {
        IS_FORK: 'true',
        HAS_RUN_LABEL: 'true',
        HAS_APPROVED_SHA: 'true',
      }).allowed,
      'true',
    )
  })

  test(`${label} authorization: a stale tier label on an unapproved (pushed) SHA is denied`, () => {
    // The draft->ready / close->reopen flip and any later fork push land here:
    // the label persists but the new head SHA carries no approval.
    assert.equal(
      inferenceAuthorization(relativePath, stepName, {
        IS_FORK: 'true',
        HAS_RUN_LABEL: 'true',
        HAS_APPROVED_SHA: 'false',
      }).allowed,
      'false',
    )
  })
}

function authorizePr(overrides = {}) {
  const script = extractRunBlock(
    '.github/actions/authorize-pr/action.yml',
    'Check authorization',
  )
  return runScript(script, {
    EVENT: 'pull_request_target',
    ACTION: 'opened',
    HEAD_REPO: 'outsider/qvac',
    BASE_REPO: 'tetherto/qvac',
    IS_DRAFT: 'false',
    HAS_WRITE: '0',
    HAS_APPROVED_SHA: 'false',
    LABEL_NAME: '',
    LABELS_JSON: '[]',
    GITHUB_ACTOR: 'outsider',
    ...overrides,
  })
}

test('authorize-pr: external fork requires SHA-bound fork-ci approval', () => {
  assert.equal(authorizePr().allowed, 'false')
  assert.equal(authorizePr({ HAS_APPROVED_SHA: 'true' }).allowed, 'true')
  assert.equal(
    authorizePr({ ACTION: 'synchronize', HAS_APPROVED_SHA: 'true' }).allowed,
    'true',
  )
  assert.equal(authorizePr({ ACTION: 'synchronize' }).allowed, 'false')
})

test('authorize-pr: same-repo synchronize remains authorised', () => {
  assert.equal(
    authorizePr({
      ACTION: 'synchronize',
      HEAD_REPO: 'tetherto/qvac',
    }).allowed,
    'true',
  )
  assert.equal(
    authorizePr({
      ACTION: 'synchronize',
      HEAD_REPO: 'TetherTo/QVAC',
    }).allowed,
    'true',
  )
})

test('authorize-pr: write access on external fork requires SHA-bound approval', () => {
  assert.equal(authorizePr({ HAS_WRITE: '1', HAS_APPROVED_SHA: 'false' }).allowed, 'false')
  assert.equal(
    authorizePr({
      HAS_WRITE: '1',
      HAS_APPROVED_SHA: 'true',
      LABEL_NAME: 'safe-to-test',
      LABELS_JSON: '[]',
    }).allowed,
    'true',
  )
})

test('authorize-pr: author association alone grants no trust on an external fork', () => {
  // authorize-pr deliberately never reads author_association: a MEMBER / OWNER
  // / COLLABORATOR badge on a fork PR says nothing about whether THIS head SHA
  // was reviewed. Injecting one must not move the decision in either direction.
  for (const assoc of ['MEMBER', 'OWNER', 'COLLABORATOR']) {
    assert.equal(
      authorizePr({
        AUTHOR_ASSOC: assoc,
        HAS_WRITE: '0',
        HAS_APPROVED_SHA: 'false',
      }).allowed,
      'false',
      `${assoc} without write and without an approved SHA is denied`,
    )
    assert.equal(
      authorizePr({
        AUTHOR_ASSOC: assoc,
        HAS_WRITE: '0',
        HAS_APPROVED_SHA: 'true',
      }).allowed,
      'true',
      `${assoc} is allowed only because the head SHA carries fork-ci approval`,
    )
  }
})

test('authorize-pr: external fork with pod label requires label and SHA', () => {
  assert.equal(
    authorizePr({
      LABEL_NAME: 'safe-to-test',
      LABELS_JSON: '[]',
    }).allowed,
    'false',
  )
  assert.equal(
    authorizePr({
      LABEL_NAME: 'safe-to-test',
      LABELS_JSON: '["safe-to-test"]',
      HAS_APPROVED_SHA: 'false',
    }).allowed,
    'false',
  )
  assert.equal(
    authorizePr({
      LABEL_NAME: 'safe-to-test',
      LABELS_JSON: '["safe-to-test"]',
      HAS_APPROVED_SHA: 'true',
    }).allowed,
    'true',
  )
})

test('sdk-python full e2e: no stale-label synchronize run; checkout pinned to head SHA', () => {
  const src = read('.github/workflows/on-pr-sdk-python-e2e-full.yml')
  // Trigger is exactly `types: [labeled]` — no synchronize (a stale
  // test-e2e-full label must not re-run a new, unreviewed SHA).
  assert.match(
    src,
    /types:\s*\[labeled\]\s*$/m,
    'pull_request trigger must be [labeled] only (no synchronize)',
  )
  assert.doesNotMatch(
    src,
    /action == 'synchronize'/,
    'run gate must not authorise a synchronize with a stale test-e2e-full label',
  )
  assert.match(
    src,
    /ref:\s*\$\{\{\s*github\.event\.pull_request\.head\.sha\s*\}\}/,
    'checkout must pin to the approved head SHA',
  )
})

test('authorize-pr: drafts are denied before internal or fork trust checks', () => {
  assert.equal(
    authorizePr({
      HEAD_REPO: 'tetherto/qvac',
      IS_DRAFT: 'true',
      HAS_WRITE: '1',
    }).allowed,
    'false',
  )
  assert.equal(
    authorizePr({
      IS_DRAFT: 'true',
      HAS_WRITE: '1',
    }).allowed,
    'false',
  )
})

// SDK e2e: internal same-repo PRs run via dedicated labels; external forks rely
// on fork-approval (fork-ci) + authorize-pr with pod-specific label inputs.
const sdkE2eWorkflows = [
  '.github/workflows/on-pr-test-sdk.yml',
  '.github/workflows/on-pr-bare-sdk-e2e.yml',
]

test('sdk e2e: run gate uses fork-approval + authorize-pr, never hardcoded verified', () => {
  for (const path of sdkE2eWorkflows) {
    const source = read(path)
    assert.match(
      source,
      /\bfork-approval:/,
      `${path} defines a fork-approval gate job`,
    )
    assert.match(
      source,
      /uses:\s*\.\/\.github\/actions\/authorize-pr/,
      `${path} uses the shared authorize-pr composite`,
    )
    assert.match(
      source,
      /needs:[\s\S]*?\bfork-approval\b/,
      `${path} gates privileged jobs on fork-approval`,
    )
    // qvac/fork-verified commit status is expected; the retired label gate is not.
    const functionalVerified = source
      .split('\n')
      .filter((line) => !line.trimStart().startsWith('#'))
      .some((line) => {
        const withoutForkStatus = line.replace(/fork-verified/g, '')
        return withoutForkStatus.includes('verified')
      })
    assert.equal(
      functionalVerified,
      false,
      `${path} must not hardcode a 'verified' gate outside comments`,
    )
  }
})

test('sdk e2e: internal PR authorised without verified; external fork stays gated', () => {
  // Both e2e workflows invoke authorize-pr with the e2e-specific label input.
  const internal = authorizePr({
    HEAD_REPO: 'tetherto/qvac',
    LABEL_NAME: 'safe-to-test',
    LABELS_JSON: '[]',
    HAS_WRITE: '0',
  })
  assert.equal(internal.allowed, 'true')

  // Case-insensitive same-repo match is honoured for internal detection.
  const internalMixedCase = authorizePr({
    HEAD_REPO: 'TetherTo/QVAC',
    LABEL_NAME: 'safe-to-test',
    LABELS_JSON: '[]',
    HAS_WRITE: '0',
  })
  assert.equal(internalMixedCase.allowed, 'true')

  const fork = authorizePr({
    HEAD_REPO: 'outsider/qvac',
    LABEL_NAME: 'safe-to-test',
    LABELS_JSON: '["safe-to-test"]',
    HAS_APPROVED_SHA: 'false',
    HAS_WRITE: '0',
  })
  assert.equal(fork.allowed, 'false')

  const forkApproved = authorizePr({
    HEAD_REPO: 'outsider/qvac',
    LABEL_NAME: 'safe-to-test',
    LABELS_JSON: '["safe-to-test"]',
    HAS_APPROVED_SHA: 'true',
    HAS_WRITE: '0',
  })
  assert.equal(forkApproved.allowed, 'true')
})

function jobBlock(source, job) {
  const header = `\n  ${job}:\n`
  const start = source.indexOf(header)
  assert.notEqual(start, -1, `job '${job}' exists in workflow`)
  const after = start + header.length
  const nextJob = source.slice(after).search(/\n {2}[A-Za-z0-9_-]+:\n/)
  return nextJob === -1 ? source.slice(start) : source.slice(start, after + nextJob)
}

test('registry-server PR jobs depend on fork-approval for fork trust', () => {
  const source = read(
    '.github/workflows/pr-models-validation-registry-server.yml',
  )
  for (const job of ['detect-changes', 'validate-json', 'test']) {
    const block = jobBlock(source, job)
    assert.match(
      block,
      /needs:[\s\S]*?\bfork-approval\b/,
      `'${job}' must depend on fork-approval`,
    )
  }
})

function publicPrLabelPolicy(overrides = {}) {
  const script = extractRunBlock(
    '.github/workflows/public-pr.yml',
    'Check tests status',
  )
  const policyBlock = script.split(
    'if [[ "${{ inputs.sanity-checks-status }}"',
  )[0]

  return runScript(
    `${policyBlock}\necho "failed=$failed" >> "$GITHUB_OUTPUT"\n`,
    {
      EVENT_NAME: 'pull_request_target',
      HEAD_REPO: 'tetherto/qvac',
      BASE_REPO: 'tetherto/qvac',
      PR_LABELS: '',
      PR_LABELS_JSON: '[]',
      ...overrides,
    },
  ).failed
}

test('public-pr: internal same-repo PR does not need verified', () => {
  assert.equal(publicPrLabelPolicy(), '0')
  assert.equal(publicPrLabelPolicy({ HEAD_REPO: 'TetherTo/QVAC' }), '0')
})

test('public-pr: external fork does not require verified label', () => {
  assert.equal(publicPrLabelPolicy({ HEAD_REPO: 'outsider/qvac' }), '0')
  assert.equal(publicPrLabelPolicy({ HEAD_REPO: '' }), '0')
})

test('public-pr: trusted non-PR calls do not require verified', () => {
  assert.equal(
    publicPrLabelPolicy({
      EVENT_NAME: 'workflow_dispatch',
      HEAD_REPO: '',
    }),
    '0',
  )
})

test('all ci-router callers re-run when a draft becomes ready', () => {
  const workflowDirectory = join(root, '.github/workflows')
  const workflowNames = [
    'on-pr-asr-ggml.yml',
    'on-pr-bci-whispercpp.yml',
    'on-pr-classification-ggml.yml',
    'on-pr-decoder-audio.yml',
    'on-pr-diffusion-cpp.yml',
    'on-pr-embed-llamacpp.yml',
    'on-pr-fabric.yml',
    'on-pr-llm-llamacpp.yml',
    'on-pr-model-fit.yml',
    'on-pr-ocr-ggml.yml',
    'on-pr-onnx.yml',
    'on-pr-translation-nmtcpp.yml',
    'on-pr-tts-ggml.yml',
    'on-pr-vla.yml',
  ]

  for (const workflowName of workflowNames) {
    const source = readFileSync(join(workflowDirectory, workflowName), 'utf8')
    assert.match(source, /uses:\s+\.\/\.github\/actions\/ci-router/)
    assert.match(source, /ready_for_review/)
  }
  assert.match(read('.github/workflows/pr-gate-merge.yml'), /ready_for_review/)
})

test('special workflows subscribe to ready and label events', () => {
  for (const relativePath of [
    '.github/workflows/pr-test-inference-addon-cpp.yml',
    '.github/workflows/pr-test-inference-addon-cpp-js.yml',
    '.github/workflows/check-approvals.yml',
  ]) {
    const source = read(relativePath)
    assert.match(source, /ready_for_review/)
    assert.match(source, /labeled/)
  }
})

test('check-approvals no longer depends on verified and skips drafts', () => {
  const source = read('.github/workflows/check-approvals.yml')
  assert.doesNotMatch(source, /verified/)
  assert.match(source, /!github\.event\.pull_request\.draft/)
})

test('coload smoke: Device Farm leg is co-load + mobile-label and authorisation gated', () => {
  // The standalone coload-smoke-mobile-ggml.yml is replaced by a reusable
  // workflow wired into each addon's on-pr pipeline. The expensive Device Farm
  // leg stays opt-in: it requires the co-load label AND the mobile label, and
  // authorisation (ci-router enforces same-repo/non-draft for internal PRs;
  // fork-ci gates external forks via fork-approval). The reusable itself must
  // pull_request trigger that could bypass that gating.
  const reusable = read('.github/workflows/coload-smoke-mobile.yml')
  assert.match(reusable, /on:\s*\n\s*workflow_call:/)
  assert.match(
    reusable,
    /uses:\s*\.\/\.github\/workflows\/test-android-sdk\.yml/,
  )
  for (const path of [
    '.github/workflows/on-pr-asr-ggml.yml',
    '.github/workflows/on-pr-tts-ggml.yml',
  ]) {
    const block = jobBlock(read(path), 'coload-smoke-mobile')
    assert.match(
      block,
      /uses:\s*\.\/\.github\/workflows\/coload-smoke-mobile\.yml/,
      `${path} runs the reusable mobile co-load`,
    )
    assert.match(
      block,
      /needs\.ci-router\.outputs\.run_coload == 'true'/,
      `${path} Device Farm co-load requires the co-load label`,
    )
    assert.match(
      block,
      /needs\.ci-router\.outputs\.run_mobile == 'true'/,
      `${path} Device Farm co-load requires the mobile label`,
    )
    assert.match(
      block,
      /needs:[\s\S]*?\bfork-approval\b/,
      `${path} Device Farm co-load requires fork-approval`,
    )
  }
})

const AWS_OIDC_SECRET = 'AWS_OIDC_ROLE_ARN'

const MOBILE_SDK_WORKFLOWS = [
  './.github/workflows/test-android-sdk.yml',
  './.github/workflows/test-ios-sdk.yml',
]

const JOB_SECRETS_KEY_RE = /^ {4}secrets:/
const SECRETS_ENTRY_RE = /^ {5,}/
const SECRETS_INHERIT_RE = /^ {4}secrets:[ \t]*inherit[ \t]*$/m

function workflowPaths() {
  return readdirSync(join(root, '.github/workflows'))
    .filter((name) => /\.ya?ml$/.test(name))
    .map((name) => `.github/workflows/${name}`)
}

function jobsCalling(source, reusable) {
  return eachJob(source).filter((job) => job.text.includes(`uses: ${reusable}`))
}

function callersOf(reusable) {
  return workflowPaths().flatMap((path) =>
    jobsCalling(read(path), reusable).map((job) => ({ path, job })),
  )
}

function withoutComments(block) {
  return block
    .split('\n')
    .map((line) => line.replace(/(^|\s)#.*$/, ''))
    .join('\n')
}

function linesUntilDedent(lines) {
  const end = lines.findIndex(
    (line) => line.trim() !== '' && !SECRETS_ENTRY_RE.test(line),
  )
  return end === -1 ? lines : lines.slice(0, end)
}

function secretsMapping(jobText) {
  const lines = jobText.split('\n')
  const start = lines.findIndex((line) => JOB_SECRETS_KEY_RE.test(line))
  if (start === -1) return ''
  return withoutComments(
    [lines[start], ...linesUntilDedent(lines.slice(start + 1))].join('\n'),
  )
}

function forwardsSecret(jobText, secret) {
  const mapping = secretsMapping(jobText)
  return (
    SECRETS_INHERIT_RE.test(mapping) ||
    new RegExp(`^ {6,}${secret}:`, 'm').test(mapping)
  )
}

function workflowCallHeader(source) {
  const jobsIdx = source.search(/^jobs:\s*$/m)
  return withoutComments(jobsIdx === -1 ? source : source.slice(0, jobsIdx))
}

function callLineCount(source, reusable) {
  return withoutComments(source)
    .split('\n')
    .filter((line) => line.trim() === `uses: ${reusable}`).length
}

function rawCallCount(reusable) {
  return workflowPaths().reduce(
    (total, path) => total + callLineCount(read(path), reusable),
    0,
  )
}

function assertDeclaresAwsRole(reusable) {
  assert.match(
    workflowCallHeader(read(reusable.replace('./', ''))),
    new RegExp(`^ {6}${AWS_OIDC_SECRET}:`, 'm'),
    `${reusable} declares ${AWS_OIDC_SECRET} in on.workflow_call.secrets`,
  )
}

function assertEveryCallWasParsed(reusable, callers) {
  assert.equal(
    callers.length,
    rawCallCount(reusable),
    `every \`uses: ${reusable}\` line resolves to a parsed caller job`,
  )
}

function assertForwardsAwsRole(reusable, { path, job }) {
  assert.ok(
    forwardsSecret(job.text, AWS_OIDC_SECRET),
    `${path} job '${job.name}' forwards ${AWS_OIDC_SECRET} to ${reusable}`,
  )
}

function assertCallersForwardAwsRole(reusable) {
  const callers = callersOf(reusable)
  assertDeclaresAwsRole(reusable)
  assertEveryCallWasParsed(reusable, callers)
  callers.forEach((caller) => assertForwardsAwsRole(reusable, caller))
}

test('mobile SDK callers forward the AWS OIDC role to Device Farm jobs', () => {
  // test-android-sdk.yml and test-ios-sdk.yml authenticate to Device Farm with
  // `role-to-assume: ${{ secrets.AWS_OIDC_ROLE_ARN }}`. That is a repository
  // secret, so the `environment: release` jobs cannot resolve it on their own:
  // a caller that omits it renders an empty role and every Device Farm job dies
  // on "Could not load credentials".
  //
  // Both workflows must declare the secret, otherwise GitHub rejects any caller
  // that passes it explicitly and `secrets: inherit` becomes the only legal
  // shape. Caller jobs come from eachJob, which only sees a bare `job-name:`
  // line, so compare against the raw `uses:` count: a caller the parser cannot
  // see must fail here rather than silently go unchecked.
  MOBILE_SDK_WORKFLOWS.forEach(assertCallersForwardAwsRole)
})

test('npm integration uses a dedicated run label, not verified', () => {
  const source = read('.github/workflows/public-reusable-npm.yml')
  const integrationStep = source.slice(
    source.indexOf('name: Run integration tests if labeled'),
  )
  assert.match(integrationStep, /run-desktop-addon-tests/)
  assert.doesNotMatch(integrationStep.split('name: Check for')[0], /verified/)
})

test('npm reusable pins PR checkout and keeps user input out of run scripts', () => {
  const source = read('.github/workflows/public-reusable-npm.yml')
  assert.match(
    source,
    /ref:\s+\$\{\{ github\.event\.pull_request\.head\.sha \|\| github\.sha \}\}/,
  )
  assert.match(source, /persist-credentials: false/)

  const echoScript = extractRunBlock(
    '.github/workflows/public-reusable-npm.yml',
    'Echo Step',
  )
  assert.doesNotMatch(echoScript, /\$\{\{\s*(github\.event|inputs\.)/)
})

const FORK_CI_ENV_RE =
  /environment:\s*\$\{\{[\s\S]*?event_name\s*==\s*'pull_request_target'[\s\S]*?head\.repo\.full_name\s*!=\s*github\.repository[\s\S]*?'fork-ci'[\s\S]*?\|\|\s*''\s*\}\}/

test('reusable-fork-approval: fork-ci gate, harden-runner, and status recording', () => {
  const source = read('.github/workflows/reusable-fork-approval.yml')
  assert.match(
    source,
    FORK_CI_ENV_RE,
    'reusable-fork-approval must gate on the fork-ci environment (fork-only conditional)',
  )
  assert.match(source, /step-security\/harden-runner@/)
  assert.match(source, /context=qvac\/fork-verified/)
  assert.match(source, /GH_TOKEN:\s*\$\{\{\s*github\.token\s*\}\}/)
  assert.match(source, /statuses:\s*write/)
  assert.match(
    source,
    /HEAD_SHA:\s*\$\{\{\s*github\.event\.pull_request\.head\.sha\s*\}\}/,
  )
  assert.match(source, /REPO:\s*\$\{\{\s*github\.repository\s*\}\}/)
  assert.doesNotMatch(
    source,
    /run:[\s\S]*?\$\{\{\s*github\.event\.pull_request\.head\.sha\s*\}\}/,
    'fork-approval must not interpolate head.sha directly in run:',
  )
})

test('audit-called-out privileged checkouts are pinned to event head SHA', () => {
  const mergeGuard = read('.github/workflows/pr-gate-merge.yml')
  assert.match(
    mergeGuard,
    /repository:\s+\$\{\{ github\.event\.pull_request\.head\.repo\.full_name \}\}\n\s+ref:\s+\$\{\{ github\.event\.pull_request\.head\.sha \}\}/,
  )

  const sanityChecks = read('.github/actions/sanity-checks/action.yaml')
  assert.match(
    sanityChecks,
    /repository:\s+\$\{\{ github\.event\.pull_request\.head\.repo\.full_name \}\}\r?\n\s+ref:\s+\$\{\{ github\.event\.pull_request\.head\.sha \}\}/,
  )
  assert.doesNotMatch(
    sanityChecks,
    /PR_HEAD_REF|PR_FORK_URL|refs\/pr\/head/,
  )
})

test('no GitHub Actions checkout/ref input resolves mutable PR head.ref', () => {
  const actionFiles = filesUnder(join(root, '.github')).filter((path) =>
    /\.(?:ya?ml)$/.test(path),
  )
  const mutableRef = /ref:\s*\$\{\{[^}\n]*head\.ref/
  const offenders = actionFiles
    .filter((path) => mutableRef.test(readFileSync(path, 'utf8')))
    .map((path) => path.slice(root.length + 1))
  assert.deepEqual(offenders, [])
})

test('cpp-lint resolves checkout from event head SHA, never branch ref', () => {
  const source = read('.github/workflows/cpp-lint.yaml')
  assert.match(
    source,
    /PR_HEAD_SHA:\s+\$\{\{ github\.event\.pull_request\.head\.sha \}\}/,
  )
  assert.match(source, /ref:\s+\$\{\{ env\.HEAD_SHA \}\}/)
  assert.doesNotMatch(source, /PR_HEAD_REF|env\.HEAD_REF/)
})

test('on-pr context outputs resolve PR ref from head SHA, never head.ref', () => {
  const workflowDirectory = join(root, '.github/workflows')
  const offenders = readdirSync(workflowDirectory)
    .filter((name) => /^on-pr-.*\.yml$/.test(name))
    .filter((name) => {
      const source = readFileSync(join(workflowDirectory, name), 'utf8')
      return (
        /HEAD_REF:\s+\$\{\{ github\.event\.pull_request\.head\.ref \}\}/.test(
          source,
        ) || /ref="\$HEAD_REF"/.test(source)
      )
    })
  assert.deepEqual(offenders, [])
})

test('infer-base changes reach the required merge-guard status check', () => {
  const source = read('.github/workflows/pr-gate-merge.yml')
  assert.match(
    source,
    /\n\s+infer-base:\n\s+- "packages\/infer-base\/\*\*"/,
    'merge guard filters on packages/infer-base',
  )

  const guard = jobBlock(source, 'qvac-merge-guard')
  assert.match(guard, /needs:[\s\S]*?\bsanity-checks\b/)
  assert.match(
    guard,
    /sanity-checks-status:\s*\$\{\{\s*needs\.sanity-checks\.result/,
    'merge guard reports the sanity-checks result',
  )
})

test('infer-base publish jobs are gated on generated-artifact validation', () => {
  const source = read('.github/workflows/trigger-reusable-infer-base.yml')

  const validate = jobBlock(source, 'validate-artifacts')
  assert.match(validate, /working-directory: packages\/infer-base/)
  assert.match(validate, /npm run test:types/)

  for (const job of [
    'publish-main-gpr-dev',
    'publish-release-npm',
    'publish-feature-gpr',
    'publish-tmp-gpr',
  ]) {
    const block = jobBlock(source, job)
    assert.match(
      block,
      /needs:[\s\S]*?- validate-artifacts/,
      `'${job}' declares validate-artifacts as a dependency`,
    )
    // Asserted explicitly rather than relying on implicit needs-failure
    // skipping, which an always() in the same condition would defeat.
    assert.match(
      block,
      /needs\.validate-artifacts\.result == 'success'/,
      `'${job}' if-gates on validate-artifacts success`,
    )
  }
})

test('merge guards accept intentionally skipped optional prebuilds', () => {
  const workflowDirectory = join(root, '.github/workflows')
  const offenders = readdirSync(workflowDirectory)
    .filter((name) => /^on-pr-.*\.yml$/.test(name))
    .filter((name) => {
      const buildStatusLines = readFileSync(
        join(workflowDirectory, name),
        'utf8',
      )
        .split('\n')
        .filter(
          (line) =>
            line.includes('build-status:') &&
            line.includes('needs.prebuild.result'),
        )
      return buildStatusLines.some(
        (line) => !line.includes("needs.prebuild.result == 'skipped'"),
      )
    })
  assert.deepEqual(offenders, [])
})

// --- fork-ci environment gating (QVAC-22799) --------------------------------
// Every pull_request_target workflow that gates any job on authorize.outputs.allowed
// must call reusable-fork-approval.yml, and every trust-gated job must depend on it.

const FORK_CI_GATE_JOBS = new Set(['authorize', 'ci-router', 'fork-approval'])

function eachJob(source) {
  const jobsIdx = source.search(/^jobs:\s*$/m)
  if (jobsIdx === -1) return []
  const lines = source.slice(jobsIdx).split('\n')
  const jobs = []
  let cur = null
  for (const line of lines) {
    const m = line.match(/^ {2}([A-Za-z0-9_-]+):\s*$/)
    if (m) {
      if (cur) jobs.push(cur)
      cur = { name: m[1], text: '' }
      continue
    }
    if (/^\S/.test(line) && cur) {
      jobs.push(cur)
      cur = null
    }
    if (cur) cur.text += line + '\n'
  }
  if (cur) jobs.push(cur)
  return jobs
}

/**
 * The `on:` block only. Selecting on a character window after `on:` (or on a
 * bare substring match) also catches prose in comments — several workflows
 * mention `pull_request_target` only to say they deliberately avoid it.
 */
function onBlock(source) {
  const match = source.match(/^on:[ \t]*$/m)
  if (!match) {
    const inline = source.match(/^on:.*$/m)
    return inline ? inline[0] : ''
  }
  const start = source.indexOf(match[0]) + match[0].length
  const lines = source.slice(start).split('\n')
  const block = []
  for (const line of lines) {
    if (/^\S/.test(line)) break
    block.push(line)
  }
  return block.join('\n')
}

function pullRequestTargetWorkflows() {
  const dir = join(root, '.github/workflows')
  return readdirSync(dir)
    .filter((n) => /\.ya?ml$/.test(n))
    .map((n) => `.github/workflows/${n}`)
    .filter((p) => /^\s{2}pull_request_target:/m.test(onBlock(read(p))))
}

/**
 * `pull_request_target` workflows that legitimately carry no fork-ci gate,
 * each with the reason it cannot execute fork-controlled code. Adding an entry
 * is a trust decision: it must be true that a fork PR cannot get code of its
 * own to run here, no matter what it puts in the branch.
 *
 * Anything not listed here must gate on fork-approval — see the exhaustiveness
 * test below, which is what forces a new workflow to be classified rather than
 * silently escaping every assertion in this section.
 */
const FORK_CI_EXEMPT = new Map([
  [
    '.github/workflows/check-approvals.yml',
    'No checkout: runs the published @qvac/ci against PR metadata over the API. ' +
      'Also a required status check on main/release — gating it on fork-ci would ' +
      'deadlock fork PRs, since approval cannot complete until the check reports.',
  ],
  [
    '.github/workflows/on-pr-community-label.yml',
    'No checkout: actions/github-script applies a label via the API only.',
  ],
  [
    '.github/workflows/pr-validation-sdk-pod.yml',
    'Checks out the base branch (no ref: on a pull_request_target checkout) and ' +
      'runs a base-branch validator over PR title/body passed via env. No secrets.',
  ],
])

function forkCiTargets() {
  return pullRequestTargetWorkflows().filter((p) => !FORK_CI_EXEMPT.has(p))
}

test('fork-ci: every pull_request_target workflow is either gated or explicitly exempt', () => {
  const unclassified = pullRequestTargetWorkflows().filter((p) => {
    if (FORK_CI_EXEMPT.has(p)) return false
    return !read(p).includes('reusable-fork-approval.yml')
  })
  assert.deepEqual(
    unclassified,
    [],
    'new pull_request_target workflow with no fork-ci gate: add `needs: fork-approval` ' +
      'or, if it genuinely cannot run fork code, add it to FORK_CI_EXEMPT with a reason',
  )
})

test('fork-ci: exempt workflows never check out fork-controlled code', () => {
  const offenders = []
  for (const path of FORK_CI_EXEMPT.keys()) {
    const source = read(path)
    // The exemptions rest on these workflows never materialising the fork's
    // tree. An explicit head ref would break that and re-open pwn-request.
    if (/ref:\s*\$\{\{\s*github\.event\.pull_request\.head\.(sha|ref)\s*\}\}/.test(source)) {
      offenders.push(`${path}: checks out PR head while exempt from fork-ci`)
    }
  }
  assert.deepEqual(offenders, [])
})

test('fork-ci: every exempt workflow still exists and carries a reason', () => {
  const known = new Set(pullRequestTargetWorkflows())
  const stale = []
  for (const [path, reason] of FORK_CI_EXEMPT) {
    if (!known.has(path)) {
      stale.push(`${path}: exempt but no longer a pull_request_target workflow — drop the entry`)
    }
    if (!reason || reason.length < 20) {
      stale.push(`${path}: exemption needs a substantive reason`)
    }
  }
  assert.deepEqual(stale, [])
})

test('fork-ci: every pull_request_target verified-surface workflow has the fork-ci gate job', () => {
  const targets = forkCiTargets()
  // Floor, not an exact count: it only guards against the discovery globbing
  // silently matching nothing (which would make every assertion below vacuous).
  // Lower it deliberately when workflow families are retired or consolidated —
  // dropped from 20 when transcription-* merged into asr-ggml, then to 18 when
  // ocr-onnx CI was retired on main.
  assert.ok(targets.length >= 18, `found ${targets.length} fork-ci target workflows`)
  for (const path of targets) {
    const gate = eachJob(read(path)).find((j) => j.name === 'fork-approval')
    assert.ok(gate, `${path}: must define a fork-approval gate job`)
    assert.match(
      gate.text,
      /uses:\s*\.\/\.github\/workflows\/reusable-fork-approval\.yml/,
      `${path}: fork-approval must call reusable-fork-approval.yml`,
    )
  }
})

test('fork-ci: fork-approval caller grants statuses: write (reusable cannot elevate token)', () => {
  const targets = forkCiTargets()
  for (const path of targets) {
    const gate = eachJob(read(path)).find((j) => j.name === 'fork-approval')
    assert.ok(gate, `${path}: must define fork-approval`)
    assert.match(
      gate.text,
      /permissions:[\s\S]*?statuses:\s*write/,
      `${path}: fork-approval caller must declare statuses: write — reusable workflows cannot elevate GITHUB_TOKEN scope`,
    )
  }
})

function jobDependsOnAuthorize(job) {
  if (job.text.includes('authorize.outputs.allowed')) return true
  return /\bneeds:[\s\S]*?\bauthorize\b/.test(job.text)
}

const reusablePrivilege = new Map()

/**
 * A local reusable workflow is a privileged fork surface when it can reach a
 * secret, land on a persistent self-hosted runner, or check out PR code.
 * Inert status aggregators like public-pr.yml (boolean inputs, hosted runner,
 * no checkout) are not, so their callers legitimately skip fork-approval.
 */
function localReusableIsPrivileged(relativePath) {
  if (reusablePrivilege.has(relativePath)) {
    return reusablePrivilege.get(relativePath)
  }
  // Seed conservatively so a cyclic `uses:` chain resolves to "privileged"
  // rather than recursing forever.
  reusablePrivilege.set(relativePath, true)

  let source
  try {
    source = read(relativePath)
  } catch {
    return true
  }

  const privileged =
    /secrets\.(?!GITHUB_TOKEN\b)/.test(source) ||
    /^\s*secrets:/m.test(source) ||
    /runs-on:.*\bqvac-/.test(source) ||
    /uses:\s*actions\/checkout@/.test(source)

  reusablePrivilege.set(relativePath, privileged)
  return privileged
}

function jobRunsPrivilegedForkSurface(job) {
  if (/secrets\.(?!GITHUB_TOKEN\b)/.test(job.text)) return true
  if (/uses:\s*[^@\n]+\n[\s\S]*?secrets:\s*inherit/.test(job.text)) return true
  // A job that delegates to a local reusable workflow carries no checkout of
  // its own, so the `actions/checkout` probe below waves it through even when
  // the reusable it calls checks out PR code on a self-hosted runner. Resolve
  // the target instead of guessing from the caller's own text.
  const delegated = job.text.match(/uses:\s*\.\/(\.github\/workflows\/\S+)/)
  if (delegated) return localReusableIsPrivileged(delegated[1])
  if (!/uses:\s*actions\/checkout@/.test(job.text)) return false
  if (/ref:\s*\$\{\{\s*github\.event\.repository\.default_branch\s*\}\}/.test(job.text)) {
    return false
  }
  if (/sparse-checkout/.test(job.text) && /default_branch/.test(job.text)) {
    return false
  }
  return true
}

test('fork-ci: every authorised-gated job depends on fork-approval (no un-gated fork run)', () => {
  for (const path of forkCiTargets()) {
    for (const job of eachJob(read(path))) {
      if (FORK_CI_GATE_JOBS.has(job.name)) continue
      if (!jobDependsOnAuthorize(job)) continue
      if (!jobRunsPrivilegedForkSurface(job)) continue
      assert.match(
        job.text,
        /needs:[\s\S]*?\bfork-approval\b/,
        `${path}: job '${job.name}' gates on authorize but does not depend on fork-approval (fail-open)`,
      )
    }
  }
})

test('authorize jobs: run after fork-approval and checkout authorize-pr from default branch only', () => {
  const dir = join(root, '.github/workflows')
  const offenders = []
  for (const name of readdirSync(dir)) {
    if (!/\.ya?ml$/.test(name)) continue
    const path = join(dir, name)
    const src = readFileSync(path, 'utf8')
    for (const job of eachJob(src)) {
      if (!/\.\/\.github\/actions\/authorize-pr/.test(job.text)) continue
      if (job.name !== 'authorize' && job.name !== 'resolve-config') continue
      if (!/\bneeds:[\s\S]*?\bfork-approval\b/.test(job.text)) {
        offenders.push(`${name}: job ${job.name} missing needs fork-approval`)
      }
      if (!/default_branch/.test(job.text)) {
        offenders.push(
          `${name}: job ${job.name} must checkout from github.event.repository.default_branch`,
        )
      }
      if (!/sparse-checkout:\s*\.github\/actions\/authorize-pr/.test(job.text)) {
        offenders.push(
          `${name}: job ${job.name} must sparse-checkout .github/actions/authorize-pr only`,
        )
      }
      if (!/persist-credentials:\s*false/.test(job.text)) {
        offenders.push(`${name}: job ${job.name} must set persist-credentials: false`)
      }
      if (!/statuses:\s*read/.test(job.text)) {
        offenders.push(
          `${name}: job ${job.name} must grant statuses: read for qvac/fork-verified lookup`,
        )
      }
    }
  }
  assert.deepEqual(offenders, [])
})

// Shared-CI-infra validation runs on plain `pull_request` (no secrets, no
// privileged context), so it deliberately carries no authorize gate and needs
// no fork-ci coverage. This test pins that posture so a future edit can't
// quietly reintroduce a secret-bearing untrusted-checkout surface.
test('shared-ci-infra: runs on pull_request (fork-safe), never pull_request_target', () => {
  const entry = read('.github/workflows/on-pr-shared-ci-infra.yml')
  assert.match(entry, /^on:\n\s*pull_request:/m)
  assert.doesNotMatch(entry, /pull_request_target/)
  assert.doesNotMatch(entry, /secrets:\s*inherit/)
  assert.doesNotMatch(entry, /HF_TOKEN/)
})

test('tts-ggml Android per-test wait remains below its Mocha ceiling', () => {
  const workflow = read('.github/workflows/integration-mobile-test-tts-ggml.yml')

  function integerValue(key) {
    const match = workflow.match(new RegExp(`^\\s*${key}:\\s*['"]?(\\d+)['"]?\\s*$`, 'm'))
    assert.ok(match, `${key} must be a literal integer`)
    return Number(match[1])
  }

  const androidWaitMs =
    integerValue('android-per-test-timeout-minutes') * MILLISECONDS_PER_MINUTE
  const mochaTimeoutMs = integerValue('mocha-timeout-ms')

  assert.ok(
    androidWaitMs < mochaTimeoutMs,
    `android per-test wait (${androidWaitMs} ms) must remain below ` +
      `Mocha timeout (${mochaTimeoutMs} ms)`,
  )
})

test('mobile scheduler preserves automatic sharding and supports explicit multi-spec dual flagship', () => {
  const action = read(
    '.github/actions/run-mobile-integration-tests/schedule-test-run/action.yml',
  )
  const llmWorkflow = read('.github/workflows/integration-mobile-test-llm-llamacpp.yml')
  const validationIndex = action.indexOf('test-specs must be a non-empty array')
  const schedulingStartedIndex = action.indexOf('SCHEDULING_STARTED=1')

  assert.match(action, /multi-spec-dual-flagship:[\s\S]*?default:\s*"false"/)
  assert.match(action, /run:\s*\|\n\s+set -euo pipefail/)
  assert.match(action, /length > 0/)
  assert.ok(
    validationIndex >= 0 && validationIndex < schedulingStartedIndex,
    'invalid or empty specs fail before rollback ownership starts',
  )
  assert.match(action, /APP_UPLOAD_ID="\$\{APP_ARN##\*\/\}"/)
  assert.match(
    action,
    /RUN_NAME_BASE="\$\{RUN_NAME_BASE\}-\$\{\{ github\.run_id \}\}\.\$\{\{ github\.run_attempt \}\}-\$\{APP_UPLOAD_ID\}"/,
  )
  assert.match(
    action,
    /if \[ "\$SPEC_COUNT" -gt 1 \] && \{ \[ "\$SCHEDULING_MODE" != "dual-flagship" \] \|\| \[ "\$MULTI_SPEC_DUAL_FLAGSHIP" != "true" \]; \}; then/,
  )
  assert.match(action, /for IDX in \$\(seq 0 \$\(\(SPEC_COUNT - 1\)\)\); do/)
  assert.match(action, /RUN_NAME_PREFIX="\$\{RUN_NAME_BASE\}-\$\{GROUP_NAME\}"/)
  assert.match(
    action,
    /RUN_ARNS_JSON=\$\(echo "\$RUN_ARNS_JSON" \| jq --arg a "\$RUN_ARN_1" --arg b "\$RUN_ARN_2" '\. \+ \[\$a,\$b\]'\)/,
  )
  assert.match(action, /S25 Ultra/)
  assert.match(action, /Pixel 9/)
  assert.match(action, /schedule_run_with_pool "\$IOS_POOL_ARN"/)
  assert.match(action, /iPhone 17/)
  assert.doesNotMatch(llmWorkflow, /multi-spec-dual-flagship:/)
})

test('mobile monitor maps both flagship runs back to each test spec', () => {
  const action = read(
    '.github/actions/run-mobile-integration-tests/monitor-test-run/action.yml',
  )
  assert.match(action, /run:\s*\|\n\s+set -euo pipefail/)
  assert.match(action, /spec_index_for_run\(\)/)
  assert.match(action, /RUN_COUNT" -eq \$\(\(SPEC_COUNT \* 2\)\)/)
  assert.match(action, /echo \$\(\(run_index \/ 2\)\)/)
  assert.match(action, /for \(\(i=0; i<RUN_COUNT; i\+\+\)\); do/)
})

test('mobile shards pass grep explicitly and retain host-phase failure logs', () => {
  const uploadAction = read(
    '.github/actions/run-mobile-integration-tests/upload-to-devicefarm/action.yml',
  )
  const generateTestspec = read(
    '.github/actions/run-mobile-integration-tests/upload-to-devicefarm/generate-testspec.sh',
  )
  const collectLogs = read(
    '.github/actions/run-mobile-integration-tests/collect-and-upload-logs/action.yml',
  )

  assert.match(uploadAction, /export GROUP_GREP_B64=/)
  assert.match(
    generateTestspec,
    /base64 -d > \/tmp\/qvacShardGrep\.txt/,
  )
  assert.match(
    generateTestspec,
    /DEVICEFARM_APPIUM_WDA_DERIVED_DATA_PATH:-/,
  )
  assert.match(collectLogs, /\*Test\*spec\*output\*/)
  assert.match(collectLogs, /\*Standard\*Output\*/)
  assert.match(collectLogs, /Host phase log:/)
})

test('tts-ggml functional mobile workflow opts into dual flagship per shard', () => {
  const workflow = read('.github/workflows/integration-mobile-test-tts-ggml.yml')
  const matrices = workflow.match(
    /fromJSON\(inputs\.run_rtf_benchmarks && '([^']+)' \|\| '([^']+)'\)/,
  )
  const jobName = workflow.match(/^\s{4}name:\s*(.+)$/m)

  assert.ok(matrices, 'benchmark and functional matrices must be literal JSON objects')
  assert.ok(jobName, 'build-and-test job must have a name')
  const benchmarkMatrix = JSON.parse(matrices[1])
  const functionalMatrix = JSON.parse(matrices[2])
  assert.deepEqual(
    functionalMatrix.include.map((entry) => entry.platform),
    ['Android', 'iOS'],
  )
  assert.equal(benchmarkMatrix.include.length, 25)
  assert.equal(
    benchmarkMatrix.include.filter((entry) => entry.platform === 'Android').length,
    13,
  )
  assert.equal(
    benchmarkMatrix.include.filter((entry) => entry.platform === 'iOS').length,
    12,
  )
  assert.match(
    workflow,
    /steps:\s*\n\s+- name: Harden runner\s*\n\s+uses: step-security\/harden-runner@bf7454d06d71f1098171f2acdf0cd4708d7b5920 # v2\.20\.0/,
  )
  assert.match(workflow, /egress-policy:\s*audit/)
  assert.match(workflow, /release environment authorizes GitHub OIDC/)
  assert.match(workflow, /test-groups:\s*\$\{\{ steps\.perf_groups\.outputs\.groups \}\}/)
  assert.doesNotMatch(workflow, /Resolve functional test-groups by engine/)
  assert.match(jobName[1], /^Build \$\{\{ matrix\.platform \}\}/)
  assert.match(jobName[1], /matrix\.engine/)
  assert.match(jobName[1], /matrix\.variant/)
  assert.match(jobName[1], /matrix\.use_gpu/)
  assert.doesNotMatch(jobName[1], /inputs\.run_rtf_benchmarks/)
  assert.match(workflow, /scheduling-mode:\s*dual-flagship/)
  assert.match(
    workflow,
    /multi-spec-dual-flagship:\s*\$\{\{ !inputs\.run_rtf_benchmarks && 'true' \|\| 'false' \}\}/,
  )
  assert.match(
    workflow,
    /TTS_GGML_MOBILE_FUNCTIONAL_MULTI_SPEC:\s*\$\{\{ !inputs\.run_rtf_benchmarks && 'true' \|\| 'false' \}\}/,
  )
  assert.match(
    workflow,
    /package-version:\s*\$\{\{ inputs\.prebuild_package \|\| inputs\.package_spec \}\}/,
  )
  assert.match(
    workflow,
    /force-npm-prebuild:\s*\$\{\{ \(inputs\.prebuild_package != '' \|\| inputs\.package_spec != ''\) && 'true' \|\| 'false' \}\}/,
  )
  assert.match(
    workflow,
    /timeout-minutes:\s*\$\{\{ !inputs\.run_rtf_benchmarks && 180 \|\| 150 \}\}/,
  )
  assert.match(
    workflow,
    /max-wait-time-seconds:\s*\$\{\{ !inputs\.run_rtf_benchmarks && '9000' \|\| '7200' \}\}/,
  )
})
