import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')

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

test('ci-router: external fork cannot use granular labels without verified', () => {
  assert.deepEqual(
    route({
      HEAD_REPO: 'outsider/qvac',
      PR_LABELS_JSON: '["run-mobile-addon-tests"]',
    }),
    falseRoute,
  )
})

test('ci-router: verified external fork gets baseline and selected heavy stage', () => {
  assert.deepEqual(
    route({
      HEAD_REPO: 'outsider/qvac',
      PR_LABELS_JSON: '["verified","run-mobile-addon-tests"]',
    }),
    {
      ...baselineRoute,
      run_prebuilds: 'true',
      run_mobile: 'true',
    },
  )
})

test('ci-router: missing head repo fails closed and repo compare is case-insensitive', () => {
  assert.deepEqual(route({ HEAD_REPO: '' }), falseRoute)
  assert.deepEqual(route({ HEAD_REPO: 'TetherTo/QVAC' }), baselineRoute)
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
    AUTHOR_ASSOC: 'NONE',
    HAS_WRITE: '0',
    // Default represents a legit, reviewed fork: the current head SHA carries
    // the merge/release-approved qvac/fork-verified status (resolved by the
    // separate 'approved' step, injected here for the decision-logic unit).
    HAS_APPROVED_SHA: 'true',
    LABEL_NAME: 'verified',
    LABELS_JSON: '["verified"]',
    GITHUB_ACTOR: 'outsider',
    ...overrides,
  })
}

test('authorize-pr: external fork synchronize is denied regardless of actor trust', () => {
  assert.equal(authorizePr({ ACTION: 'synchronize' }).allowed, 'false')
  assert.equal(
    authorizePr({ ACTION: 'synchronize', HAS_WRITE: '1' }).allowed,
    'false',
  )
  assert.equal(
    authorizePr({
      ACTION: 'synchronize',
      AUTHOR_ASSOC: 'MEMBER',
    }).allowed,
    'false',
  )
})

test('authorize-pr: same-repo synchronize and reviewed fork open remain authorised', () => {
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
  assert.equal(authorizePr().allowed, 'true')
})

test('authorize-pr: SHA-bound — flip events do not authorise an unapproved head (Marcus)', () => {
  // draft->ready and close->reopen replay a stale approval onto a new commit
  // whose SHA was never approved (HAS_APPROVED_SHA=false). Both must deny.
  assert.equal(
    authorizePr({ ACTION: 'ready_for_review', HAS_APPROVED_SHA: 'false' }).allowed,
    'false',
  )
  assert.equal(
    authorizePr({ ACTION: 'reopened', HAS_APPROVED_SHA: 'false' }).allowed,
    'false',
  )
  // Even a plain reopen/open with the label present but an unapproved head SHA.
  assert.equal(
    authorizePr({ ACTION: 'opened', HAS_APPROVED_SHA: 'false' }).allowed,
    'false',
  )
})

test('authorize-pr: SHA-bound — labeled event authorises on the approval moment even before the status lands', () => {
  // On the `labeled` event label-gate records the status in a parallel job;
  // authorize-pr must authorise on label presence here (race-safe) and let
  // label-gate enforce applier-team trust + strip.
  assert.equal(
    authorizePr({ ACTION: 'labeled', HAS_APPROVED_SHA: 'false' }).allowed,
    'true',
  )
})

test('authorize-pr: SHA-bound — reviewed fork at the approved head stays authorised across events', () => {
  assert.equal(
    authorizePr({ ACTION: 'reopened', HAS_APPROVED_SHA: 'true' }).allowed,
    'true',
  )
  assert.equal(
    authorizePr({ ACTION: 'ready_for_review', HAS_APPROVED_SHA: 'true' }).allowed,
    'true',
  )
})

test('authorize-pr: write access still bypasses the label/SHA gate from a fork', () => {
  // A write-access actor could push to base directly, so trusting their fork PR
  // is no riskier — this stays true regardless of the SHA status.
  assert.equal(
    authorizePr({ ACTION: 'reopened', HAS_APPROVED_SHA: 'false', HAS_WRITE: '1' }).allowed,
    'true',
  )
})

test('authorize-pr: author_association does NOT bypass the fork gate (NamelsKing part 1)', () => {
  // An org member / collaborator WITHOUT repo write, from a fork, must not run
  // fork code without a SHA-bound approval — closes the AUTHOR_ASSOC fall-through.
  for (const assoc of ['MEMBER', 'OWNER', 'COLLABORATOR']) {
    assert.equal(
      authorizePr({
        ACTION: 'opened',
        AUTHOR_ASSOC: assoc,
        HAS_WRITE: '0',
        LABELS_JSON: '[]',
      }).allowed,
      'false',
      `${assoc} without write must not bypass the fork label`,
    )
    // Even with the label present, an unapproved head SHA denies (no ordering proof).
    assert.equal(
      authorizePr({
        ACTION: 'reopened',
        AUTHOR_ASSOC: assoc,
        HAS_WRITE: '0',
        HAS_APPROVED_SHA: 'false',
      }).allowed,
      'false',
      `${assoc} without write must not ride a stale approval on a flip`,
    )
  }
  // With a genuine SHA-bound approval they ARE authorised — via the label/SHA
  // path, not author_association.
  assert.equal(
    authorizePr({
      ACTION: 'reopened',
      AUTHOR_ASSOC: 'MEMBER',
      HAS_WRITE: '0',
      HAS_APPROVED_SHA: 'true',
    }).allowed,
    'true',
  )
})

test('authorize-pr: external fork without the label is denied regardless of SHA status', () => {
  assert.equal(
    authorizePr({ ACTION: 'opened', LABELS_JSON: '[]', HAS_APPROVED_SHA: 'true' }).allowed,
    'false',
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
      AUTHOR_ASSOC: 'MEMBER',
    }).allowed,
    'false',
  )
})

// SDK e2e must inherit the fork-only trust model: internal same-repo PRs run
// e2e via their own dedicated labels (test-e2e-smoke / test-e2e-full) with NO
// 'verified' requirement, while external forks stay gated. Both workflows
// derive their run gate from the shared label-gate + authorize-pr composites
// rather than hardcoding a 'verified' check.
const sdkE2eWorkflows = [
  '.github/workflows/on-pr-test-sdk.yml',
  '.github/workflows/on-pr-bare-sdk-e2e.yml',
]

test('sdk e2e: run gate derives from shared label-gate, never a hardcoded verified check', () => {
  for (const path of sdkE2eWorkflows) {
    const source = read(path)
    assert.match(
      source,
      /uses:\s*\.\/\.github\/actions\/label-gate/,
      `${path} uses the shared label-gate composite`,
    )
    assert.match(
      source,
      /uses:\s*\.\/\.github\/actions\/authorize-pr/,
      `${path} uses the shared authorize-pr composite`,
    )
    assert.match(
      source,
      /needs\.label-gate\.outputs\.authorised == 'true'/,
      `${path} gates its run job on label-gate.authorised`,
    )
    // The only 'verified' token allowed is inside a comment line; a functional
    // 'verified' gate here would re-gate internal PRs and regress Dima's ask.
    const functionalVerified = source
      .split('\n')
      .filter((line) => !line.trimStart().startsWith('#'))
      .some((line) => line.includes('verified'))
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
    AUTHOR_ASSOC: 'NONE',
    HAS_WRITE: '0',
  })
  assert.equal(internal.allowed, 'true')

  // Case-insensitive same-repo match is honoured for internal detection.
  const internalMixedCase = authorizePr({
    HEAD_REPO: 'TetherTo/QVAC',
    LABEL_NAME: 'safe-to-test',
    LABELS_JSON: '[]',
    AUTHOR_ASSOC: 'NONE',
    HAS_WRITE: '0',
  })
  assert.equal(internalMixedCase.allowed, 'true')

  const fork = authorizePr({
    HEAD_REPO: 'outsider/qvac',
    LABEL_NAME: 'safe-to-test',
    LABELS_JSON: '[]',
    AUTHOR_ASSOC: 'NONE',
    HAS_WRITE: '0',
  })
  assert.equal(fork.allowed, 'false')
})

// Applying `verified` is a privileged trust decision: only the merge and
// release teams may do it. The label-gate action resolves the label applier
// and authorises only if they belong to a configured team, so restricting the
// team default to merge+release is the enforcement point. Individual
// contributor / partner teams (qvac-internal-dev, qvac-collabora) must NOT be
// trusted appliers.
test('label-gate default teams are scoped to merge + release only', () => {
  const source = read('.github/actions/label-gate/action.yml')
  // Isolate the teams input's block-scalar default (from `default: |` up to
  // the next input, `users:`), so the descriptive prose that mentions the
  // excluded teams by name does not leak into the assertion.
  const teamsIdx = source.indexOf('  teams:')
  const usersIdx = source.indexOf('  users:', teamsIdx)
  assert.ok(teamsIdx !== -1 && usersIdx > teamsIdx, 'teams then users inputs')
  const defaultMarker = 'default: |'
  const defaultIdx = source.indexOf(defaultMarker, teamsIdx)
  assert.ok(
    defaultIdx !== -1 && defaultIdx < usersIdx,
    'teams uses a block-scalar default',
  )
  const defaultTeams = source
    .slice(defaultIdx + defaultMarker.length, usersIdx)
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
  assert.deepEqual(defaultTeams, ['qvac-internal-merge', 'qvac-internal-release'])
})

// Regression for the authorize-pr-only bypass: the registry-server PR jobs
// that check out fork head and run `npm install` / tests must gate on
// label-gate (verified by merge/release), not authorize-pr alone — otherwise
// an external org member runs unreviewed fork code in a pull_request_target
// context without verified.
function jobBlock(source, job) {
  const header = `\n  ${job}:\n`
  const start = source.indexOf(header)
  assert.notEqual(start, -1, `job '${job}' exists in workflow`)
  const after = start + header.length
  const nextJob = source.slice(after).search(/\n {2}[A-Za-z0-9_-]+:\n/)
  return nextJob === -1 ? source.slice(start) : source.slice(start, after + nextJob)
}

test('registry-server PR jobs gate fork code on label-gate, not authorize alone', () => {
  const source = read(
    '.github/workflows/pr-models-validation-registry-server.yml',
  )
  for (const job of ['detect-changes', 'validate-json', 'test']) {
    const block = jobBlock(source, job)
    assert.match(
      block,
      /needs:.*\blabel-gate\b/,
      `'${job}' declares label-gate as a dependency`,
    )
    assert.match(
      block,
      /needs\.label-gate\.outputs\.authorised == 'true'/,
      `'${job}' if-gates on label-gate.authorised`,
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

test('public-pr: external or missing head repo needs verified', () => {
  assert.equal(publicPrLabelPolicy({ HEAD_REPO: 'outsider/qvac' }), '1')
  assert.equal(publicPrLabelPolicy({ HEAD_REPO: '' }), '1')
  assert.equal(
    publicPrLabelPolicy({
      HEAD_REPO: 'outsider/qvac',
      PR_LABELS: 'verified',
      PR_LABELS_JSON: '["verified"]',
    }),
    '0',
  )
  assert.equal(
    publicPrLabelPolicy({
      HEAD_REPO: 'outsider/qvac',
      PR_LABELS: 'not verified',
      PR_LABELS_JSON: '["not verified"]',
    }),
    '1',
  )
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
    'on-pr-bci-whispercpp.yml',
    'on-pr-classification-ggml.yml',
    'on-pr-decoder-audio.yml',
    'on-pr-diffusion-cpp.yml',
    'on-pr-embed-llamacpp.yml',
    'on-pr-fabric.yml',
    'on-pr-llm-llamacpp.yml',
    'on-pr-ocr-ggml.yml',
    'on-pr-ocr-onnx.yml',
    'on-pr-onnx.yml',
    'on-pr-transcription-parakeet.yml',
    'on-pr-transcription-whispercpp.yml',
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
    '.github/workflows/coload-smoke-mobile-ggml.yml',
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

test('coload smoke is same-repo, non-draft, and mobile-label gated', () => {
  const source = read('.github/workflows/coload-smoke-mobile-ggml.yml')
  assert.match(source, /run-mobile-addon-tests/)
  assert.match(source, /!github\.event\.pull_request\.draft/)
  assert.match(
    source,
    /github\.event\.pull_request\.head\.repo\.full_name == github\.repository/,
  )
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

test('authorize-pr strips every external-fork synchronize', () => {
  const source = read('.github/actions/authorize-pr/action.yml')
  const stripStep = source.slice(
    source.indexOf('name: Strip label on new external-fork pushes'),
  )
  assert.match(stripStep, /github\.event\.action == 'synchronize'/)
  assert.match(
    stripStep,
    /github\.event\.pull_request\.head\.repo\.full_name != github\.repository/,
  )
  assert.doesNotMatch(
    stripStep.split('shell: bash')[0],
    /has-permission|HAS_WRITE/,
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
