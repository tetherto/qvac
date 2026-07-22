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
    ACTION: 'opened',
    IS_FORK: 'false',
    IS_DRAFT: 'false',
    HAS_VERIFIED_LABEL: 'false',
    HAS_RUN_LABEL: 'false',
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

  test(`${label} authorization: external fork needs verified and ${runLabel}`, () => {
    assert.equal(
      inferenceAuthorization(relativePath, stepName, { IS_FORK: 'true' })
        .allowed,
      'false',
    )
    assert.equal(
      inferenceAuthorization(relativePath, stepName, {
        IS_FORK: 'true',
        HAS_VERIFIED_LABEL: 'true',
      }).allowed,
      'false',
    )
    assert.equal(
      inferenceAuthorization(relativePath, stepName, {
        IS_FORK: 'true',
        HAS_RUN_LABEL: 'true',
      }).allowed,
      'false',
    )
    assert.equal(
      inferenceAuthorization(relativePath, stepName, {
        IS_FORK: 'true',
        HAS_VERIFIED_LABEL: 'true',
        HAS_RUN_LABEL: 'true',
      }).allowed,
      'true',
    )
  })

  test(`${label} authorization: fork synchronize is denied even before label strip`, () => {
    assert.equal(
      inferenceAuthorization(relativePath, stepName, {
        ACTION: 'synchronize',
        IS_FORK: 'true',
        HAS_VERIFIED_LABEL: 'true',
        HAS_RUN_LABEL: 'true',
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
