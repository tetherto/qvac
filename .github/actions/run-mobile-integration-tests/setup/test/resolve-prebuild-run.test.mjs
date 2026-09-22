// Guards the prebuild-run-id resolution used by the mobile setup action. This is
// the path that puts an unmerged native change on a device, so its failure modes
// matter more than its happy path: it must never quietly degrade into testing
// the published release. The HTTP client is injected, so nothing here needs a
// network, a token or a real run.
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  candidateArtifactNames,
  isSafeWorkdir,
  describeAvailableBundles,
  conclusionWarning,
  conflictingSource,
  sourceRepositoryWarning,
  formatProvenance,
  main,
  mergedArtifactName,
  parseRunId,
  platformPrebuildDirs,
  resolvePrebuildRun,
  selectArtifact,
} from '../resolve-prebuild-run.mjs'

const REPO = 'tetherto/qvac'
const RUN_ID = '33179656677'
const HEAD_SHA = '1d2c3b4a5f6e7d8c9b0a1f2e3d4c5b6a7f8e9d01'

function run(overrides = {}) {
  return {
    id: Number(RUN_ID),
    name: 'On PR Trigger (LLM)',
    path: '.github/workflows/on-pr-llm-llamacpp.yml',
    head_sha: HEAD_SHA,
    head_branch: 'feat/backend-selection',
    head_repository: { full_name: REPO },
    status: 'completed',
    conclusion: 'success',
    ...overrides,
  }
}

// Stands in for the REST API. Records every URL so a test can prove which calls
// were made — in particular that NOTHING is requested when validation fails.
function fakeApi({ runResponse, artifactPages = [[]], status = 200 }) {
  const calls = []
  let page = 0

  const respond = (body, code = 200) => ({
    ok: code >= 200 && code < 300,
    status: code,
    json: async () => body,
  })

  return {
    calls,
    request: async (url) => {
      calls.push(url)
      if (status !== 200) return respond({ message: 'boom' }, status)
      if (url.includes('/artifacts')) {
        const artifacts = artifactPages[page] ?? []
        page += 1
        return respond({ artifacts })
      }
      if (runResponse === null) return respond({ message: 'Not Found' }, 404)
      return respond(runResponse ?? run())
    },
  }
}

function baseEnv(overrides = {}) {
  return {
    PREBUILD_RUN_ID: RUN_ID,
    ADDON_WORKDIR: 'packages/llm-llamacpp',
    PLATFORM: 'Android',
    PACKAGE_VERSION: '',
    FORCE_NPM_PREBUILD: 'false',
    GITHUB_TOKEN: 'ghs-test-token',
    REPO,
    ...overrides,
  }
}

async function expectFailure(env, api) {
  await assert.rejects(() => resolvePrebuildRun({ env, request: api.request }), (error) => {
    assert.ok(error.message, 'the failure carries a message')
    return true
  })
}

test('parseRunId accepts only a positive integer run id', () => {
  assert.equal(parseRunId('33179656677'), '33179656677')
  assert.equal(parseRunId('  42  '), '42')

  // Every one of these arrives from a dispatch input and would otherwise be
  // pasted into an API path.
  for (const hostile of [
    '',
    '0',
    '-1',
    '12.5',
    '4242abc',
    '4242/../../secrets',
    '4242?per_page=1',
    'latest',
    '../../etc/passwd',
    null,
    undefined,
  ]) {
    assert.equal(parseRunId(hostile), null, `must reject ${JSON.stringify(hostile)}`)
  }
})

test('the artifact name is derived the way reusable-prebuilds.yml uploads it', () => {
  assert.equal(mergedArtifactName('packages/llm-llamacpp'), 'prebuilds-llm-llamacpp')
  assert.equal(mergedArtifactName('packages/vla/'), 'prebuilds-vla')
  assert.equal(mergedArtifactName('./packages/ocr-ggml'), 'prebuilds-ocr-ggml')
  assert.equal(mergedArtifactName(''), null)
  assert.equal(mergedArtifactName('..'), null)

  // The legacy bare name stays as a fallback so an older run id still resolves.
  assert.deepEqual(candidateArtifactNames('packages/tts-ggml'), [
    'prebuilds-tts-ggml',
    'prebuilds',
  ])
})

test('platform maps to the prebuild dir the mobile build actually consumes', () => {
  assert.deepEqual(platformPrebuildDirs('Android'), ['android-arm64'])
  assert.deepEqual(platformPrebuildDirs('iOS'), ['ios-arm64'])
  // Case matters — the workflows pass the matrix value verbatim.
  assert.deepEqual(platformPrebuildDirs('android'), [])
  assert.deepEqual(platformPrebuildDirs(''), [])
})

test('an expired own bundle is NOT replaced by a live bare one', () => {
  // The bare name carries no addon identity, so preferring it over this addon's
  // own EXPIRED bundle would install another addon's binaries and go green —
  // the failure class this route exists to close.
  const selected = selectArtifact(
    [
      { name: 'prebuilds-llm-llamacpp', expired: true, id: 1 },
      { name: 'prebuilds', expired: false, id: 2 },
    ],
    candidateArtifactNames('packages/llm-llamacpp'),
  )
  assert.deepEqual(selected, { name: 'prebuilds-llm-llamacpp', id: null, expired: true })

  assert.deepEqual(
    selectArtifact(
      [{ name: 'prebuilds-llm-llamacpp', expired: false, id: 7 }, { name: 'prebuilds', id: 8 }],
      candidateArtifactNames('packages/llm-llamacpp'),
    ),
    { name: 'prebuilds-llm-llamacpp', id: 7, expired: false },
  )
})

test('the legacy bare name is still used when this addon has no bundle at all', () => {
  const selected = selectArtifact(
    [{ name: 'prebuilds', expired: false, id: 9 }],
    candidateArtifactNames('packages/llm-llamacpp'),
  )
  assert.deepEqual(selected, { name: 'prebuilds', id: 9, expired: false })
})

test('isSafeWorkdir refuses anything that could escape the addon checkout', () => {
  // It selects the directory the run clears with rm -rf, and 8 mobile workflows
  // expose it as a dispatch input.
  for (const ok of ['packages/ocr-ggml', 'packages/inference-addon-cpp/mobile', './packages/vla-ggml']) {
    assert.equal(isSafeWorkdir(ok), true, ok)
  }
  for (const bad of ['../../../otherrepo', '/etc', 'packages/../../x', '', 'C:\\x', 'a\\b']) {
    assert.equal(isSafeWorkdir(bad), false, JSON.stringify(bad))
  }
})

test('a traversing workdir is refused before anything is deleted', async () => {
  const api = fakeApi({})
  await assert.rejects(
    () => resolvePrebuildRun({ env: baseEnv({ ADDON_WORKDIR: '../../../otherrepo' }), request: api.request }),
    /is not a plain relative path/,
  )
  assert.deepEqual(api.calls, [], 'nothing is requested for a rejected workdir')
})

test('all-expired is distinguishable from never-existed', () => {
  const expired = selectArtifact(
    [{ name: 'prebuilds-llm-llamacpp', expired: true, id: 1 }],
    candidateArtifactNames('packages/llm-llamacpp'),
  )
  assert.equal(expired.expired, true)

  const absent = selectArtifact(
    [{ name: 'perf-report-android', expired: false, id: 9 }],
    candidateArtifactNames('packages/llm-llamacpp'),
  )
  assert.equal(absent, null)
})

test('conflictingSource names whichever competing pin was set', () => {
  assert.equal(conflictingSource({ packageVersion: '', forceNpmPrebuild: 'false' }), null)
  assert.match(
    conflictingSource({ packageVersion: '@qvac/llm-llamacpp@0.47.0' }),
    /@qvac\/llm-llamacpp@0\.47\.0/,
  )
  assert.match(
    conflictingSource({ packageVersion: '', forceNpmPrebuild: 'true' }),
    /force-npm-prebuild=true/,
  )
})

test('provenance names the run, the artifact and the head SHA', () => {
  const line = formatProvenance(run(), 'prebuilds-llm-llamacpp')
  assert.match(line, new RegExp(RUN_ID))
  assert.match(line, new RegExp(HEAD_SHA))
  assert.match(line, /prebuilds-llm-llamacpp/)
  assert.match(line, /On PR Trigger \(LLM\)/)
})

test('a non-success source run warns but is still usable', () => {
  // The prebuild job uploads before desktop tests and lint, so a red run
  // regularly holds good binaries. Refusing it would block the main use case.
  assert.equal(conclusionWarning(run()), null)
  assert.match(conclusionWarning(run({ conclusion: 'failure' })), /concluded 'failure'/)
  assert.equal(conclusionWarning(run({ conclusion: null })), null)
})

// A fork PR's on-pr run sits in the base repo's run list while its
// head_repository is the fork (verified live: on-pr-nx.yml carries runs with
// head_repository 'ogad-tether/qvac'). This warns rather than refusing — the
// repo is fork-first, and a fork bundle only exists once the merge/release team
// approved `fork-ci` on that run.
test('a fork-built source run is surfaced, not silently accepted', () => {
  assert.equal(sourceRepositoryWarning(run(), REPO), null)

  const forkWarning = sourceRepositoryWarning(
    run({ head_repository: { full_name: 'ogad-tether/qvac' } }),
    REPO,
  )
  assert.match(forkWarning, /FORK 'ogad-tether\/qvac'/)
  // The warning must not read as an error: this is the documented workflow.
  assert.match(forkWarning, /normal for a fork PR/)
  assert.match(forkWarning, /fork-ci/)

  // A payload with no head_repository must not be read as "same repo".
  assert.match(sourceRepositoryWarning(run({ head_repository: null }), REPO), /cannot be confirmed/)
  assert.match(sourceRepositoryWarning({ id: 1 }, REPO), /cannot be confirmed/)
})

test('a fork-built run still resolves, with the warning attached', async () => {
  const api = fakeApi({
    runResponse: run({ head_repository: { full_name: 'ogad-tether/qvac' } }),
    artifactPages: [[{ name: 'prebuilds-llm-llamacpp', expired: false, id: 2 }]],
  })

  const resolved = await resolvePrebuildRun({ env: baseEnv(), request: api.request })
  assert.equal(resolved.artifactName, 'prebuilds-llm-llamacpp')
  assert.ok(
    resolved.warnings.some((warning) => warning.includes("FORK 'ogad-tether/qvac'")),
    `the fork must be called out, got ${JSON.stringify(resolved.warnings)}`,
  )
})

test('a fork run that ALSO concluded red carries both warnings', () => {
  // The two warnings are independent; neither may swallow the other.
  return resolvePrebuildRun({
    env: baseEnv(),
    request: fakeApi({
      runResponse: run({
        head_repository: { full_name: 'ogad-tether/qvac' },
        conclusion: 'failure',
      }),
      artifactPages: [[{ name: 'prebuilds-llm-llamacpp', expired: false, id: 2 }]],
    }).request,
  }).then((resolved) => {
    assert.equal(resolved.warnings.length, 2, JSON.stringify(resolved.warnings))
  })
})

test('the provenance line names the repository the code came from', () => {
  assert.match(formatProvenance(run(), 'prebuilds-llm-llamacpp'), /\(tetherto\/qvac\)/)
})

test('resolves a real on-pr run to its merged bundle', async () => {
  const api = fakeApi({
    artifactPages: [
      [
        { name: 'perf-report-android', expired: false, id: 1 },
        { name: 'prebuilds-llm-llamacpp', expired: false, id: 2 },
      ],
    ],
  })

  const resolved = await resolvePrebuildRun({ env: baseEnv(), request: api.request })

  assert.equal(resolved.artifactName, 'prebuilds-llm-llamacpp')
  assert.equal(resolved.runId, RUN_ID)
  assert.equal(resolved.headSha, HEAD_SHA)
  assert.deepEqual(resolved.expectedDirs, ['android-arm64'])
  assert.match(resolved.provenance, new RegExp(`run ${RUN_ID}`))
  assert.deepEqual(resolved.warnings, [])
  assert.ok(
    api.calls.some((url) => url === `https://api.github.com/repos/${REPO}/actions/runs/${RUN_ID}`),
    `the run itself is fetched:\n${api.calls.join('\n')}`,
  )
})

test('a malformed run id fails before any request is made', async () => {
  const api = fakeApi({})
  const env = baseEnv({ PREBUILD_RUN_ID: 'my-branch' })

  await assert.rejects(
    () => resolvePrebuildRun({ env, request: api.request }),
    /must be a numeric GitHub Actions run id/,
  )
  assert.deepEqual(api.calls, [], 'nothing is requested for a rejected run id')
})

test('prebuild_run_id together with a pinned package is an error, not a precedence puzzle', async () => {
  const api = fakeApi({})

  await assert.rejects(
    () =>
      resolvePrebuildRun({
        env: baseEnv({ PACKAGE_VERSION: '@tetherto/llm-llamacpp-mono@0.47.0-tmp.runid-1' }),
        request: api.request,
      }),
    /mutually exclusive/,
  )
  await assert.rejects(
    () =>
      resolvePrebuildRun({
        env: baseEnv({ FORCE_NPM_PREBUILD: 'true' }),
        request: api.request,
      }),
    /mutually exclusive/,
  )
  assert.deepEqual(api.calls, [], 'a conflicting request never reaches the API')
})

test('a missing token fails closed and names the permission', async () => {
  const api = fakeApi({})

  await assert.rejects(
    () => resolvePrebuildRun({ env: baseEnv({ GITHUB_TOKEN: '' }), request: api.request }),
    /actions:read/,
  )
  assert.deepEqual(api.calls, [])
})

test('an unknown platform fails before any request', async () => {
  const api = fakeApi({})
  await assert.rejects(
    () => resolvePrebuildRun({ env: baseEnv({ PLATFORM: 'Windows' }), request: api.request }),
    /expected Android or iOS/,
  )
  assert.deepEqual(api.calls, [])
})

test('a run id that does not exist points the reader at the run URL', async () => {
  const api = fakeApi({ runResponse: null })

  await assert.rejects(
    () => resolvePrebuildRun({ env: baseEnv(), request: api.request }),
    (error) => {
      assert.match(error.message, new RegExp(`Run ${RUN_ID} does not exist`))
      assert.ok(
        error.hints.some((hint) => hint.includes(`/actions/runs/${RUN_ID}`)),
        'the hint links the run',
      )
      return true
    },
  )
})

test('403 on the run lookup blames the missing actions:read permission', async () => {
  const api = fakeApi({ status: 403 })

  await assert.rejects(() => resolvePrebuildRun({ env: baseEnv(), request: api.request }), (error) => {
    assert.ok(
      error.hints.some((hint) => hint.includes('actions: read')),
      `hints should name the permission, got ${JSON.stringify(error.hints)}`,
    )
    return true
  })
})

test('an expired artifact fails closed and says so', async () => {
  // The whole failure mode this ticket exists to stop: retention lapses, and
  // the run must NOT slide back to @latest.
  const api = fakeApi({
    artifactPages: [[{ name: 'prebuilds-llm-llamacpp', expired: true, id: 2 }]],
  })

  await assert.rejects(() => resolvePrebuildRun({ env: baseEnv(), request: api.request }), (error) => {
    assert.match(error.message, /has expired/)
    assert.ok(
      error.hints.some((hint) => hint.includes('retention')),
      'the hint explains retention',
    )
    assert.ok(
      error.hints.some((hint) => hint.includes('new run id')),
      'the hint says what to do next',
    )
    return true
  })
})

// A real nx run carries 65+ artifacts, so listing them all buries the answer.
test('the not-found hint names the addons a run DID build, not every artifact', () => {
  const artifacts = [
    { name: 'prebuilds-llm-llamacpp' },
    { name: 'prebuilds-ocr-ggml' },
    { name: 'prebuilds-llm-llamacpp' }, // duplicated across legs in real runs
    { name: 'prebuild-llm-llamacpp-win32-x64' }, // per-matrix leg, not a bundle
    { name: 'prebuilds-cache-pr-4519-8b692edcec92ec00' }, // reuse marker
    { name: 'coverage-report' },
    { name: 'ocr-ggml-perf-report-linux-x64' },
  ]

  const hints = describeAvailableBundles(artifacts)
  assert.match(hints[0], /prebuilds for: llm-llamacpp, ocr-ggml\./)
  assert.ok(!hints.join(' ').includes('cache-pr'), hints.join(' '))
  assert.ok(!hints.join(' ').includes('coverage-report'), hints.join(' '))
  assert.ok(!hints.join(' ').includes('win32-x64'), 'a per-matrix leg is not a bundle')
  assert.ok(
    hints.join('\n').length < 400,
    `the hint must stay readable, got ${hints.join('\n').length} chars`,
  )
})

test('a long bundle list is capped rather than dumped', () => {
  const artifacts = Array.from({ length: 30 }, (_, index) => ({ name: `prebuilds-addon-${index}` }))
  const hints = describeAvailableBundles(artifacts, 5)
  assert.match(hints[0], /\+25 more/)
})

test('a run with artifacts but no bundle says so plainly', () => {
  const hints = describeAvailableBundles([{ name: 'coverage-report' }, { name: 'logs' }])
  assert.match(hints[0], /2 artifact\(s\) but no prebuilds bundle/)
  assert.match(hints[1], /on-pr-<addon>\.yml/)
})

test('a run with no artifacts at all says that instead of an empty list', () => {
  assert.deepEqual(describeAvailableBundles([]), ['That run published no artifacts at all.'])
})

test('a run with no prebuilds artifact lists what it does have', async () => {
  const api = fakeApi({
    runResponse: run({ name: 'Docs website health check', path: '.github/workflows/docs.yml' }),
    artifactPages: [[{ name: 'link-report', expired: false, id: 5 }]],
  })

  await assert.rejects(() => resolvePrebuildRun({ env: baseEnv(), request: api.request }), (error) => {
    assert.match(error.message, /has no 'prebuilds-llm-llamacpp' or 'prebuilds' artifact/)
    assert.ok(
      error.hints.some((hint) => hint.includes('no prebuilds bundle')),
      `the hint must say the run builds no bundles, got ${JSON.stringify(error.hints)}`,
    )
    assert.ok(
      error.hints.some((hint) => hint.includes('Docs website health check')),
      'the hint names the run the reader actually picked',
    )
    return true
  })
})

test('a run that published nothing says that instead of listing an empty set', async () => {
  const api = fakeApi({ artifactPages: [[]] })

  await assert.rejects(() => resolvePrebuildRun({ env: baseEnv(), request: api.request }), (error) => {
    assert.ok(error.hints.some((hint) => hint.includes('no artifacts at all')))
    return true
  })
})

// `gh run list --limit 1` returns the newest run, which on an active branch is
// usually still building. "Does not build prebuilds" is wrong there.
test('a still-running source run says so instead of "builds no prebuilds"', async () => {
  for (const status of ['in_progress', 'queued', 'waiting']) {
    const api = fakeApi({
      runResponse: run({ status, conclusion: null }),
      artifactPages: [[{ name: 'coverage-report', expired: false, id: 1 }]],
    })

    await assert.rejects(() => resolvePrebuildRun({ env: baseEnv(), request: api.request }), (error) => {
      assert.match(error.message, new RegExp(`still '${status}'`))
      assert.ok(
        error.hints.some((hint) => hint.includes('dispatch again with the same run id')),
        `the hint must say to wait and retry, got ${JSON.stringify(error.hints)}`,
      )
      assert.ok(
        !error.hints.some((hint) => hint.includes('does not build prebuilds')),
        'must not blame the workflow for an unfinished run',
      )
      return true
    })
  }
})

test('a completed run with no bundle still blames the workflow, not the clock', async () => {
  const api = fakeApi({
    runResponse: run({ status: 'completed', conclusion: 'success' }),
    artifactPages: [[{ name: 'coverage-report', expired: false, id: 1 }]],
  })

  await assert.rejects(() => resolvePrebuildRun({ env: baseEnv(), request: api.request }), (error) => {
    assert.match(error.message, /has no 'prebuilds-llm-llamacpp' or 'prebuilds' artifact/)
    return true
  })
})

// An empty body and an empty run are different facts.
test('a failed artifact listing is not reported as an empty run', async () => {
  const calls = []
  const request = async (url) => {
    calls.push(url)
    if (url.includes('/artifacts')) {
      return { ok: true, status: 200, json: async () => null }
    }
    return { ok: true, status: 200, json: async () => run() }
  }

  await assert.rejects(() => resolvePrebuildRun({ env: baseEnv(), request }), (error) => {
    assert.match(error.message, /Could not list run .* artifacts/)
    assert.ok(error.hints.some((hint) => hint.includes('actions: read')))
    return true
  })
})

test('a truncated artifact listing fails loudly rather than guessing', async () => {
  // Every page full to the page bound: the bundle may sit just past it, so
  // "no prebuilds here" would be a guess presented as a fact.
  const fullPage = Array.from({ length: 100 }, (_, index) => ({
    name: `filler-${index}`,
    expired: false,
    id: index,
  }))
  const request = async (url) => ({
    ok: true,
    status: 200,
    json: async () => (url.includes('/artifacts') ? { artifacts: fullPage } : run()),
  })

  await assert.rejects(() => resolvePrebuildRun({ env: baseEnv(), request }), (error) => {
    assert.match(error.message, /listing was truncated/)
    return true
  })
})

test('created_at breaks the tie when it disagrees with id order', async () => {
  const api = fakeApi({
    artifactPages: [
      [
        { name: 'prebuilds-llm-llamacpp', expired: false, id: 999, created_at: '2026-01-01T00:00:00Z' },
        { name: 'prebuilds-llm-llamacpp', expired: false, id: 111, created_at: '2026-06-01T00:00:00Z' },
      ],
    ],
  })
  const resolved = await resolvePrebuildRun({ env: baseEnv(), request: api.request })
  assert.equal(resolved.artifactId, 111, 'the later created_at wins over the larger id')
})

test('the resolved artifact ID is surfaced so the download cannot pick another row', async () => {
  // A re-run leaves the earlier attempt's artifacts under the same run id, so a
  // run can hold two live rows with the same name.
  const api = fakeApi({
    artifactPages: [
      [
        { name: 'prebuilds-llm-llamacpp', expired: false, id: 111 },
        { name: 'prebuilds-llm-llamacpp', expired: false, id: 222 },
      ],
    ],
  })

  const resolved = await resolvePrebuildRun({ env: baseEnv(), request: api.request })
  // The NEWEST row, not the first listed: the API lists id-ascending, so
  // first-match would pin the pre-re-run binary while the provenance line
  // printed the same head_sha either way.
  assert.equal(resolved.artifactId, 222, 'the newest matching row wins')
})

test('the artifact listing is paginated, so the bundle is found past page 1', async () => {
  // A real LLM run carries well over 100 artifacts (per-matrix prebuilds, perf
  // reports, device logs), so a single-page lookup would miss the bundle.
  const firstPage = Array.from({ length: 100 }, (_, index) => ({
    name: `perf-report-${index}`,
    expired: false,
    id: index,
  }))
  const api = fakeApi({
    artifactPages: [firstPage, [{ name: 'prebuilds-llm-llamacpp', expired: false, id: 999 }]],
  })

  const resolved = await resolvePrebuildRun({ env: baseEnv(), request: api.request })
  assert.equal(resolved.artifactName, 'prebuilds-llm-llamacpp')
  assert.equal(
    api.calls.filter((url) => url.includes('/artifacts')).length,
    2,
    'the second page is requested',
  )
})

test('GITHUB_API_URL is honoured so GHES is not hardcoded to api.github.com', async () => {
  const api = fakeApi({
    artifactPages: [[{ name: 'prebuilds-llm-llamacpp', expired: false, id: 2 }]],
  })

  await resolvePrebuildRun({
    env: baseEnv({ GITHUB_API_URL: 'https://ghe.example/api/v3/' }),
    request: api.request,
  })

  assert.ok(
    api.calls.every((url) => url.startsWith('https://ghe.example/api/v3/repos/')),
    `all calls should hit the configured API host:\n${api.calls.join('\n')}`,
  )
})

test('iOS resolves the ios-arm64 dir', async () => {
  const api = fakeApi({
    artifactPages: [[{ name: 'prebuilds-llm-llamacpp', expired: false, id: 2 }]],
  })
  const resolved = await resolvePrebuildRun({
    env: baseEnv({ PLATFORM: 'iOS' }),
    request: api.request,
  })
  assert.deepEqual(resolved.expectedDirs, ['ios-arm64'])
})

test('main writes the step outputs the action consumes', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'qvac-prebuild-run-'))
  const outputFile = join(directory, 'github-output')
  const logs = []
  const api = fakeApi({
    artifactPages: [[{ name: 'prebuilds-llm-llamacpp', expired: false, id: 2 }]],
  })

  try {
    const code = await main({
      env: baseEnv({ GITHUB_OUTPUT: outputFile }),
      request: api.request,
      log: { log: (line) => logs.push(line) },
    })

    assert.equal(code, 0, logs.join('\n'))
    const written = readFileSync(outputFile, 'utf8')
    // Exactly the names action.yml reads back.
    assert.match(written, /^artifact_name=prebuilds-llm-llamacpp$/m)
    assert.match(written, /^artifact_id=2$/m)
    assert.match(written, new RegExp(`^source_run_id=${RUN_ID}$`, 'm'))
    assert.match(written, new RegExp(`^head_sha=${HEAD_SHA}$`, 'm'))
    assert.match(written, /^expected_dirs=android-arm64$/m)
    assert.ok(
      logs.some((line) => line.includes(`run ${RUN_ID}`) && line.includes(HEAD_SHA)),
      `the provenance line is printed:\n${logs.join('\n')}`,
    )
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test('main exits non-zero and emits ::error:: on failure, writing no outputs', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'qvac-prebuild-run-'))
  const outputFile = join(directory, 'github-output')
  const logs = []

  try {
    const code = await main({
      env: baseEnv({ PREBUILD_RUN_ID: 'nope', GITHUB_OUTPUT: outputFile }),
      request: fakeApi({}).request,
      log: { log: (line) => logs.push(line) },
    })

    assert.equal(code, 1)
    assert.ok(
      logs.some((line) => line.startsWith('::error::')),
      `the failure is annotated for the run summary:\n${logs.join('\n')}`,
    )
    // No outputs means the download step gets an empty artifact name and
    // cannot silently pull something else.
    assert.throws(() => readFileSync(outputFile, 'utf8'))
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test('main warns about a red source run without refusing it', async () => {
  const logs = []
  const api = fakeApi({
    runResponse: run({ conclusion: 'failure' }),
    artifactPages: [[{ name: 'prebuilds-llm-llamacpp', expired: false, id: 2 }]],
  })

  const code = await main({
    env: baseEnv(),
    request: api.request,
    log: { log: (line) => logs.push(line) },
  })

  assert.equal(code, 0)
  assert.ok(logs.some((line) => line.startsWith('::warning::')), logs.join('\n'))
})

// Keeps expectFailure referenced: a resolver that suddenly succeeds for an
// empty env would mean every guard above was bypassed.
test('an empty environment resolves nothing', async () => {
  await expectFailure({}, fakeApi({}))
})
