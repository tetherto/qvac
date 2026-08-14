'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const {
  parseArgs,
  runIdForFile,
  loadArtifactRecords,
  parseCanonicalTestLabel,
  normalizeBackend,
  requestedBackendOfResult,
  fellBackToOtherBackend,
  normalizeDitVariant,
  isCanonicalReport,
  isDesktopArtifact,
  deriveNoisy,
  normalizeDesktopRecord,
  expandCanonicalReport,
  normalizeManualRecord,
  manualRecordProblems,
  manualItemsOf,
  manualItemToRecords,
  dedupeRecords,
  sortRecords,
  missingGpuBackends,
  renderMarkdown,
  buildJsonReport,
  VALID_BACKENDS,
  VALID_DIT_VARIANTS
} = require('../aggregate-audiogen-ggml-rtf')

const {
  buildCanonicalReport,
  backendIdToName
} = require('../../../packages/audiogen-ggml/test/utils/benchmark-report')

const { patternArgs } = require('../gh-artifacts')

const MB = 1024 * 1024

function desktopReport (overrides = {}) {
  return {
    schemaVersion: 1,
    platform: 'linux-x64',
    platformName: 'linux',
    engine: 'acestep',
    model: { type: 'acestep', ditVariant: 'turbo-q4', sizeBytes: 3200 * MB },
    labels: {
      device: 'qvac-ubuntu2404-x64-gpu',
      runner: 'qvac-ubuntu2404-x64-gpu',
      backend: 'vulkan',
      activeBackend: 'vulkan',
      requestedBackend: 'gpu',
      label: '1-turbo-q4-gpu'
    },
    config: {
      useGPU: true,
      ditVariant: 'turbo-q4',
      durationS: 15,
      inferenceSteps: null,
      numThreads: null,
      warmupRuns: 1,
      benchmarkRuns: 3
    },
    correlation: { githubRunId: '4242', githubSha: 'deadbeef' },
    summary: {
      rtf: { mean: 1.25, p50: 1.2, p95: 1.4, stddev: 0.05, count: 3 },
      wallMs: { mean: 18750.4 },
      audioDurationMs: { mean: 15000 },
      coldRtf: 1.9,
      modelLoadMs: 4210.6,
      modelSizeBytes: 3200 * MB,
      memory: { avgRssMb: 3200.5, peakRssMb: 4100.25, reclaimedMb: 2900.1 },
      noisy: false,
      ...overrides.summary
    },
    ...overrides.report
  }
}

function mobileCanonicalReport (testLabel = '[GPU] acestep turbo-q8 vulkan') {
  return {
    schema_version: '1.0',
    addon: 'audiogen-ggml',
    addon_type: 'audiogen-ggml',
    timestamp: '2026-08-04T10:00:00.000Z',
    run_number: '99',
    device: {
      name: 'Google Pixel 8 Pro',
      platform: 'android',
      arch: 'arm64',
      gpu: 'Mali-G715',
      runner: 'aws-device-farm-Android'
    },
    results: [
      {
        test: testLabel,
        execution_provider: 'gpu',
        engine: 'acestep',
        ditVariant: 'turbo-q8',
        metrics: {
          real_time_factor: 6.5,
          rtf_p50: 6.4,
          rtf_p95: 6.9,
          wall_time_ms: 97500,
          audio_duration_ms: 15000,
          cold_rtf: 8.1,
          model_load_ms: 30500,
          avg_rss_mb: 3600.5,
          peak_rss_mb: 4200.75,
          reclaimed_mb: 3100.25
        }
      }
    ]
  }
}

function writeReportUnderRun (root, runId, report) {
  const dir = path.join(root, runId, 'perf-report-audiogen-ggml-android')
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'performance-report.json'), JSON.stringify(report))
}

test('normalizeDitVariant accepts the three published DiT variants only', () => {
  assert.equal(normalizeDitVariant('turbo-q4'), 'turbo-q4')
  assert.equal(normalizeDitVariant('TURBO-Q8'), 'turbo-q8')
  assert.equal(normalizeDitVariant('sft'), 'sft')
  assert.equal(normalizeDitVariant('q4'), '', 'a tts-style quant token is not a DiT variant')
  assert.equal(normalizeDitVariant(undefined), '')
})

test('normalizeBackend follows the audiogen-cpp cascade and honours a hint', () => {
  assert.equal(normalizeBackend('linux', true, ''), 'vulkan')
  assert.equal(normalizeBackend('win32', true, ''), 'vulkan')
  assert.equal(normalizeBackend('android', true, ''), 'vulkan')
  assert.equal(normalizeBackend('darwin', true, ''), 'metal')
  assert.equal(normalizeBackend('ios', true, ''), 'metal')
  assert.equal(normalizeBackend('linux', false, ''), 'cpu')
  assert.equal(normalizeBackend('linux', true, 'cuda'), 'cuda', 'an explicit hint wins')
  assert.equal(
    normalizeBackend('linux', true, 'gpu'),
    'vulkan',
    'the generic gpu hint defers to the cascade'
  )
})

test('report shape detection distinguishes desktop, canonical and neither', () => {
  assert.ok(isDesktopArtifact(desktopReport()))
  assert.ok(isCanonicalReport(mobileCanonicalReport()))
  assert.ok(!isDesktopArtifact(mobileCanonicalReport()))
  assert.ok(!isCanonicalReport(desktopReport()))
  assert.ok(!isCanonicalReport({ schema_version: '1.0', addon: 'tts-ggml', results: [], device: {} }))
  assert.ok(!isDesktopArtifact({ engine: 'chatterbox', summary: {}, model: {} }))
})

test('parseCanonicalTestLabel recovers provider, variant and backend', () => {
  assert.deepEqual(parseCanonicalTestLabel('[GPU] acestep turbo-q4 vulkan'), {
    useGPU: true,
    engine: 'acestep',
    ditVariant: 'turbo-q4',
    backendHint: 'vulkan'
  })
  assert.deepEqual(parseCanonicalTestLabel('[CPU] acestep sft cpu'), {
    useGPU: false,
    engine: 'acestep',
    ditVariant: 'sft',
    backendHint: 'cpu'
  })
})

test('parseCanonicalTestLabel tolerates a missing or unknown tail', () => {
  assert.deepEqual(parseCanonicalTestLabel('[CPU] acestep'), {
    useGPU: false,
    engine: 'acestep',
    ditVariant: '',
    backendHint: null
  })
  assert.equal(parseCanonicalTestLabel('not a label'), null)
  assert.equal(parseCanonicalTestLabel(''), null)
})

test('normalizeDesktopRecord carries the variant, memory and correlation through', () => {
  const record = normalizeDesktopRecord(desktopReport(), '/tmp/rtf-benchmark-linux-x64-turbo-q4-gpu.json')

  assert.equal(record.source, 'desktop-ci')
  assert.equal(record.ditVariant, 'turbo-q4')
  assert.equal(record.gpu, 'gpu')
  assert.equal(record.backend, 'vulkan')
  assert.equal(record.device, 'qvac-ubuntu2404-x64-gpu')
  assert.equal(record.meanRtf, 1.25)
  assert.equal(record.coldRtf, 1.9)
  assert.equal(record.durationS, 15)
  assert.equal(record.avgRssMb, 3200.5)
  assert.equal(record.peakRssMb, 4100.25)
  assert.equal(record.reclaimedMb, 2900.1)
  assert.equal(record.modelSizeMb, 3200)
  assert.equal(record.runId, '4242')
  assert.equal(record.sha, 'deadbeef')
  assert.equal(record.notes, 'rtf-benchmark-linux-x64-turbo-q4-gpu.json')
})

test('normalizeDesktopRecord treats a CPU run as cpu regardless of the backend label', () => {
  const report = desktopReport()
  report.config.useGPU = false
  report.labels.backend = 'cpu'
  report.labels.activeBackend = 'cpu'

  const record = normalizeDesktopRecord(report, 'artifact.json')
  assert.equal(record.gpu, 'cpu')
  assert.equal(record.backend, 'cpu')
})

test('normalizeDesktopRecord prefers the backend the engine actually ran on', () => {
  const report = desktopReport()
  report.labels.backend = 'vulkan'
  report.labels.activeBackend = 'cpu'

  const record = normalizeDesktopRecord(report, 'artifact.json')
  assert.equal(record.backend, 'cpu', 'a GPU run that fell back to CPU is reported as CPU')
})

test('deriveNoisy prefers the recorded flag and otherwise computes the ratio', () => {
  assert.equal(deriveNoisy({ noisy: true, rtf: { mean: 1, stddev: 0 } }), true)
  assert.equal(deriveNoisy({ rtf: { mean: 1, stddev: 0.3 } }), true)
  assert.equal(deriveNoisy({ rtf: { mean: 1, stddev: 0.05 } }), false)
  assert.equal(deriveNoisy({ rtf: { mean: 0, stddev: 0.3 } }), null, 'no mean means no verdict')
  assert.equal(deriveNoisy({}), null)
})

test('expandCanonicalReport turns a mobile report into rows', () => {
  const records = expandCanonicalReport(mobileCanonicalReport(), '/tmp/performance-report.json')

  assert.equal(records.length, 1)
  const [record] = records
  assert.equal(record.source, 'mobile-ci')
  assert.equal(record.device, 'Google Pixel 8 Pro')
  assert.equal(record.platform, 'android-arm64')
  assert.equal(record.ditVariant, 'turbo-q8')
  assert.equal(record.gpu, 'gpu')
  assert.equal(record.backend, 'vulkan')
  assert.equal(record.gpuModel, 'Mali-G715')
  assert.equal(record.meanRtf, 6.5)
  assert.equal(record.peakRssMb, 4200.75)
})

test('expandCanonicalReport stamps the supplied run id rather than the run_number', () => {
  const report = mobileCanonicalReport()

  const [stamped] = expandCanonicalReport(report, 'file.json', '31166105125')
  assert.equal(stamped.runId, '31166105125', 'the Run column holds a GitHub run id')

  const [unstamped] = expandCanonicalReport(report, 'file.json')
  assert.equal(unstamped.runId, '', 'run_number 99 is a per-workflow counter, not a run id')
})

test('runIdForFile reads the run id off the staging directory', () => {
  const root = '/tmp/staging'

  assert.equal(
    runIdForFile(path.join(root, '31166105125', 'perf', 'performance-report.json'), root, ''),
    '31166105125',
    'gh run download names the per-run directory for the run'
  )
  assert.equal(
    runIdForFile(path.join(root, 'perf', 'performance-report.json'), root, ''),
    '',
    'a directory that is not a run id is left out rather than guessed at'
  )
  assert.equal(
    runIdForFile(path.join(root, '31166105125', 'performance-report.json'), root, '999'),
    '999',
    'an explicit --run-id wins over the directory'
  )
})

test('a multi-run fetch attributes each mobile row to the run it came from', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'audiogen-multi-run-'))
  writeReportUnderRun(root, '31166105125', mobileCanonicalReport())
  writeReportUnderRun(root, '31200000001', mobileCanonicalReport())

  const runIds = loadArtifactRecords(root, '').map((record) => record.runId).sort()

  assert.deepEqual(
    runIds,
    ['31166105125', '31200000001'],
    'one --run-id cannot cover a fetch spanning several runs'
  )
  fs.rmSync(root, { recursive: true, force: true })
})

test('the fetch names both lane artifacts so prebuilds are left behind', () => {
  const args = patternArgs(['rtf-results-audiogen-ggml-*', 'perf-report-audiogen-ggml-*'])

  assert.deepEqual(args, [
    '-p', 'rtf-results-audiogen-ggml-*',
    '-p', 'perf-report-audiogen-ggml-*'
  ])
  assert.deepEqual(patternArgs('one-*'), ['-p', 'one-*'], 'a lone glob still works')
  assert.deepEqual(patternArgs(null), [], 'no pattern downloads everything, as before')
})

test('parseArgs takes a workflow to fetch from instead of a local directory', () => {
  const fetched = parseArgs(['--workflow', 'Benchmark Performance (AudioGen GGML)'])
  assert.equal(fetched.workflow, 'Benchmark Performance (AudioGen GGML)')
  assert.equal(fetched.runs, 6, 'the weekly report defaults to six runs like the other addons')

  const local = parseArgs(['--dir', 'artifacts'])
  assert.equal(local.input, 'artifacts')
  assert.equal(local.workflow, '', 'a local directory needs no CI query')

  assert.throws(
    () => parseArgs(['--output', 'report.md']),
    /--input \/ --dir argument, or --workflow/,
    'neither source given is still an error'
  )
})

test('a report built for an unnamed ggml backend round-trips into the table', () => {
  const report = buildCanonicalReport({
    settings: { ditVariant: 'sft', useGPU: true, durationS: 10, inferenceSteps: 50 },
    summary: {
      activeBackend: backendIdToName(99),
      rtf: { mean: 2.5, stddev: 0.1, min: 2.4, max: 2.6 },
      memory: { peakRssMb: 4200, avgRssMb: 4000 }
    },
    backend: 'vulkan',
    device: { device: 'Pixel 8 Pro', platform: 'android-arm64', platformName: 'android' }
  })

  const [record] = expandCanonicalReport(report, 'performance-report.json')
  assert.equal(record.backend, 'other-gpu', 'not relabelled as the platform default')
  assert.equal(record.gpu, 'gpu')
  assert.equal(record.ditVariant, 'sft')
})

test('expandCanonicalReport falls back to the record field when the label lacks a variant', () => {
  const [record] = expandCanonicalReport(mobileCanonicalReport('[GPU] acestep vulkan'), 'file.json')
  assert.equal(record.ditVariant, 'turbo-q8', 'the result-level ditVariant fills the gap')
})

test('expandCanonicalReport ignores results from another engine', () => {
  const report = mobileCanonicalReport()
  report.results[0].test = '[GPU] chatterbox q4 vulkan'
  assert.deepEqual(expandCanonicalReport(report, 'file.json'), [])
})

test('normalizeManualRecord reads the flat shape a human fills in', () => {
  const record = normalizeManualRecord(
    {
      device: 'Mac Studio M2 Ultra',
      platform: 'darwin-arm64',
      platformFamily: 'darwin',
      ditVariant: 'sft',
      useGPU: true,
      meanRtf: 3.2,
      peakRssMb: 5200,
      notes: 'local Metal run'
    },
    '/manual/metal.json'
  )

  assert.equal(record.source, 'manual')
  assert.equal(record.ditVariant, 'sft')
  assert.equal(record.backend, 'metal')
  assert.equal(record.meanRtf, 3.2)
  assert.equal(record.notes, 'local Metal run')
})

test('manualRecordProblems rejects a variant outside the allowlist instead of coercing it', () => {
  const problems = manualRecordProblems({
    device: 'box',
    platform: 'linux-x64',
    ditVariant: 'mystery',
    backend: 'cpu',
    meanRtf: 1.2
  })
  assert.equal(problems.length, 1)
  assert.match(problems[0], /unknown ditVariant "mystery"/)
})

test('manualRecordProblems rejects a backend outside the allowlist', () => {
  const problems = manualRecordProblems({
    device: 'box',
    platform: 'linux-x64',
    ditVariant: 'sft',
    backend: 'banana',
    meanRtf: 1.2
  })
  assert.equal(problems.length, 1)
  assert.match(problems[0], /unknown backend "banana"/)
})

test('manualItemToRecords drops a malformed variant rather than reporting it as turbo-q4', () => {
  const records = manualItemToRecords(
    { device: 'box', platform: 'linux-x64', ditVariant: 'mystery', backend: 'cpu', meanRtf: 1.2 },
    'file.json'
  )
  assert.deepEqual(records, [])
})

test('manualRecordProblems accepts every allowlisted variant and backend', () => {
  for (const ditVariant of VALID_DIT_VARIANTS) {
    for (const backend of VALID_BACKENDS) {
      const problems = manualRecordProblems({
        device: 'box',
        platform: 'linux-x64',
        ditVariant,
        backend,
        meanRtf: 1.2
      })
      assert.deepEqual(problems, [], `${ditVariant}/${backend} should be accepted`)
    }
  }
})

test('dedupeRecords keeps distinct variants and backends but folds true duplicates', () => {
  const base = normalizeDesktopRecord(desktopReport(), 'a.json')
  const sameRunnerOtherVariant = { ...base, ditVariant: 'sft' }
  const sameRunnerOtherBackend = { ...base, gpu: 'cpu', backend: 'cpu' }
  const exactDuplicate = { ...base }

  const deduped = dedupeRecords([base, sameRunnerOtherVariant, sameRunnerOtherBackend, exactDuplicate])
  assert.equal(deduped.length, 3)
})

test('sortRecords groups rows by source, platform and variant', () => {
  const rows = sortRecords([
    { source: 'mobile-ci', platform: 'android-arm64', ditVariant: 'turbo-q4', gpu: 'gpu', device: 'p8' },
    { source: 'desktop-ci', platform: 'linux-x64', ditVariant: 'sft', gpu: 'cpu', device: 'box' },
    { source: 'desktop-ci', platform: 'linux-x64', ditVariant: 'turbo-q4', gpu: 'cpu', device: 'box' }
  ])

  assert.deepEqual(
    rows.map((row) => `${row.source}/${row.ditVariant}`),
    ['desktop-ci/sft', 'desktop-ci/turbo-q4', 'mobile-ci/turbo-q4']
  )
})

test('missingGpuBackends reports only backends with no GPU row', () => {
  const vulkanRow = { gpu: 'gpu', backend: 'vulkan' }
  const cpuRow = { gpu: 'cpu', backend: 'cpu' }

  assert.deepEqual(missingGpuBackends([vulkanRow, cpuRow]), ['metal'])
  assert.deepEqual(missingGpuBackends([vulkanRow, { gpu: 'gpu', backend: 'metal' }]), [])
  assert.deepEqual(missingGpuBackends([cpuRow]), ['vulkan', 'metal'])
})

test('renderMarkdown emits the DiT variant column and a coverage warning', () => {
  const markdown = renderMarkdown([normalizeDesktopRecord(desktopReport(), 'a.json')])

  assert.match(markdown, /## ACE-Step \(audiogen-ggml\) Performance Findings/)
  assert.match(markdown, /\| DiT Variant \|/)
  assert.match(markdown, /\| turbo-q4 \| gpu \| vulkan \|/)
  assert.match(markdown, /1\.2500/, 'mean RTF is rendered to four decimals')
  assert.match(markdown, /GPU backends with no coverage in this run: metal/)
})

test('renderMarkdown still produces a table when nothing was collected', () => {
  const markdown = renderMarkdown([])

  assert.match(markdown, /no benchmark artifacts found/)
  assert.match(markdown, /Rows: 0\./)
})

test('buildJsonReport carries the records and the coverage gap', () => {
  const report = buildJsonReport([normalizeDesktopRecord(desktopReport(), 'a.json')])

  assert.equal(report.addon, 'audiogen-ggml')
  assert.equal(report.engine, 'acestep')
  assert.equal(report.recordCount, 1)
  assert.deepEqual(report.missingGpuBackends, ['metal'])
  assert.equal(report.records[0].ditVariant, 'turbo-q4')
})

const VALID_MANUAL = {
  device: 'RTX 4090 workstation',
  platform: 'linux-x64',
  ditVariant: 'turbo-q4',
  backend: 'cuda',
  meanRtf: 0.42
}

test('manualRecordProblems accepts a fully populated record', () => {
  assert.deepEqual(manualRecordProblems(VALID_MANUAL), [])
})

test('manualRecordProblems rejects anything that is not a JSON object', () => {
  for (const value of [null, undefined, 'text', 42, [], true]) {
    assert.deepEqual(
      manualRecordProblems(value),
      ['not a JSON object'],
      `rejects ${JSON.stringify(value)}`
    )
  }
})

test('manualRecordProblems lists every missing required field for an empty object', () => {
  const problems = manualRecordProblems({})

  assert.equal(problems.length, 5)
  assert.ok(problems.some((p) => p.includes('device')))
  assert.ok(problems.some((p) => p.includes('platform')))
  assert.ok(problems.some((p) => p.includes('ditVariant')))
  assert.ok(problems.some((p) => p.includes('backend/provider')))
  assert.ok(problems.some((p) => p.includes('meanRtf')))
})

test('manualRecordProblems rejects a non-positive or unparseable mean RTF', () => {
  for (const meanRtf of [0, -1, 'fast', null, undefined, NaN]) {
    const problems = manualRecordProblems({ ...VALID_MANUAL, meanRtf })
    assert.ok(
      problems.some((p) => p.includes('meanRtf')),
      `rejects meanRtf=${meanRtf}`
    )
  }
})

test('manualRecordProblems accepts provider or executionProvider in place of backend', () => {
  const { backend, ...withoutBackend } = VALID_MANUAL

  assert.deepEqual(manualRecordProblems({ ...withoutBackend, provider: 'cuda' }), [])
  assert.deepEqual(manualRecordProblems({ ...withoutBackend, executionProvider: 'cuda' }), [])
  assert.ok(manualRecordProblems(withoutBackend).some((p) => p.includes('backend/provider')))
})

test('manualRecordProblems accepts a nested model.ditVariant', () => {
  const { ditVariant, ...withoutVariant } = VALID_MANUAL

  assert.deepEqual(manualRecordProblems({ ...withoutVariant, model: { ditVariant: 'sft' } }), [])
})

test('manualItemToRecords skips an invalid record instead of emitting an unknown row', () => {
  const warnings = []
  const original = console.warn
  console.warn = (message) => warnings.push(message)
  try {
    assert.deepEqual(manualItemToRecords({}, 'bad.json'), [])
    assert.deepEqual(manualItemToRecords(null, 'bad.json'), [])
  } finally {
    console.warn = original
  }

  assert.equal(warnings.length, 2)
  assert.match(warnings[0], /Skipping manual record in bad\.json/)
})

test('manualItemToRecords keeps a valid record', () => {
  const records = manualItemToRecords(VALID_MANUAL, 'good.json')

  assert.equal(records.length, 1)
  assert.equal(records[0].source, 'manual')
  assert.equal(records[0].backend, 'cuda')
  assert.equal(records[0].meanRtf, 0.42)
})

test('manualItemsOf only treats an actual list as a record list', () => {
  assert.deepEqual(manualItemsOf([VALID_MANUAL]), [VALID_MANUAL])
  assert.deepEqual(manualItemsOf({ records: [VALID_MANUAL] }), [VALID_MANUAL])
  assert.deepEqual(manualItemsOf(VALID_MANUAL), [VALID_MANUAL], 'a bare record is wrapped')
})

test('manualItemsOf does not iterate a malformed records value', () => {
  const malformed = { records: 'turbo-q4' }
  assert.deepEqual(manualItemsOf(malformed), [malformed], 'a string is not spread into characters')
  assert.deepEqual(manualItemsOf({ records: { a: 1 } }).length, 1, 'an object is not iterated')
})

test('normalizeDesktopRecord reports CPU when a GPU request fell back', () => {
  const report = desktopReport()
  report.labels.activeBackend = 'cpu'

  const record = normalizeDesktopRecord(report, 'fallback.json')

  assert.equal(record.backend, 'cpu')
  assert.equal(record.gpu, 'cpu', 'the provider column follows the backend that ran')
})

test('normalizeDesktopRecord keeps GPU when the request was honoured', () => {
  const record = normalizeDesktopRecord(desktopReport(), 'ok.json')

  assert.equal(record.backend, 'vulkan')
  assert.equal(record.gpu, 'gpu')
})

test('requestedBackendOfResult reads the request and falls back to what ran', () => {
  assert.equal(
    requestedBackendOfResult(
      { requested_backend: 'vulkan', requested_execution_provider: 'gpu' },
      'android',
      'cpu'
    ),
    'vulkan'
  )
  assert.equal(
    requestedBackendOfResult({}, 'android', 'cpu'),
    'cpu',
    'an artifact without the field claims no unmet request'
  )
})

test('fellBackToOtherBackend only flags a row whose request went unmet', () => {
  assert.ok(fellBackToOtherBackend({ backend: 'cpu', requestedBackend: 'vulkan' }))
  assert.ok(!fellBackToOtherBackend({ backend: 'vulkan', requestedBackend: 'vulkan' }))
  assert.ok(!fellBackToOtherBackend({ backend: 'cpu' }))
})

test('a mobile GPU request that fell back keeps the backend it asked for', () => {
  const report = mobileCanonicalReport('[CPU] acestep turbo-q4 cpu')
  report.results[0].execution_provider = 'cpu'
  report.results[0].requested_backend = 'vulkan'
  report.results[0].requested_execution_provider = 'gpu'

  const [record] = expandCanonicalReport(report, 'android-gpu.json')

  assert.equal(record.backend, 'cpu', 'the observed backend still drives the row')
  assert.equal(record.gpu, 'cpu')
  assert.equal(record.requestedBackend, 'vulkan')
})

test('a desktop GPU request that fell back keeps the backend it asked for', () => {
  const report = desktopReport()
  report.labels.activeBackend = 'cpu'

  const record = normalizeDesktopRecord(report, 'fallback.json')

  assert.equal(record.backend, 'cpu')
  assert.equal(record.requestedBackend, 'vulkan')
})

test('a fallback row survives beside the genuine CPU run on the same device', () => {
  const cpuReport = desktopReport()
  cpuReport.config.useGPU = false
  cpuReport.labels.backend = 'cpu'
  cpuReport.labels.activeBackend = 'cpu'
  cpuReport.labels.label = '1-turbo-q4-cpu'

  const fallbackReport = desktopReport()
  fallbackReport.labels.activeBackend = 'cpu'
  fallbackReport.labels.label = '1-turbo-q4-cpu'

  const deduped = dedupeRecords([
    normalizeDesktopRecord(cpuReport, 'cpu.json'),
    normalizeDesktopRecord(fallbackReport, 'gpu-fallback.json')
  ])

  assert.equal(deduped.length, 2, 'the two runs measured different things')
  assert.deepEqual(
    deduped.map((record) => record.requestedBackend).sort(),
    ['cpu', 'vulkan']
  )
})

test('renderMarkdown names both backends on a fallback row and counts them', () => {
  const report = desktopReport()
  report.labels.activeBackend = 'cpu'

  const markdown = renderMarkdown([normalizeDesktopRecord(report, 'fallback.json')])

  assert.match(markdown, /\| cpu \(requested vulkan\) \|/)
  assert.match(markdown, /1 row\(s\) ran on a different backend than the one requested/)
})

test('a fallback row does not count as coverage for the backend it asked for', () => {
  const report = desktopReport()
  report.labels.activeBackend = 'cpu'

  const records = [normalizeDesktopRecord(report, 'fallback.json')]

  assert.deepEqual(missingGpuBackends(records), ['vulkan', 'metal'])
})

test('normalizeManualRecord derives the provider from the stated backend', () => {
  const record = normalizeManualRecord(
    { device: 'box', platform: 'linux-x64', ditVariant: 'sft', backend: 'cuda', meanRtf: 0.4 },
    'cuda.json'
  )

  assert.equal(record.backend, 'cuda')
  assert.equal(record.gpu, 'gpu', 'a CUDA drop is GPU work even without an explicit useGPU flag')
})
