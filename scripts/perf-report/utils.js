'use strict'

/**
 * Shared helpers for the performance report aggregation pipeline.
 */

// ---------------------------------------------------------------------------
// Statistics
// ---------------------------------------------------------------------------

function mean (arr) {
  if (!arr.length) return 0
  return arr.reduce((s, v) => s + v, 0) / arr.length
}

function stddev (arr) {
  if (arr.length < 2) return 0
  const avg = mean(arr)
  const sqDiffs = arr.map(v => (v - avg) ** 2)
  return Math.sqrt(sqDiffs.reduce((s, v) => s + v, 0) / (arr.length - 1))
}

function summarize (values) {
  const nums = values.filter(v => v !== null && v !== undefined && !isNaN(v))
  if (!nums.length) return null
  return {
    mean: round2(mean(nums)),
    min: round2(Math.min(...nums)),
    max: round2(Math.max(...nums)),
    std: round2(stddev(nums)),
    count: nums.length,
    values: nums.map(round2)
  }
}

function round2 (v) {
  return Math.round(v * 100) / 100
}

// ---------------------------------------------------------------------------
// Metric display helpers
// ---------------------------------------------------------------------------

const METRIC_LABELS = {
  total_time_ms: 'Total time',
  detection_time_ms: 'Detection time',
  recognition_time_ms: 'Recognition time',
  prefill_time_ms: 'Prefill time',
  decode_time_ms: 'Decode time',
  vision_encode_time_ms: 'Vision encode',
  ttft_ms: 'TTFT',
  generated_tokens: 'Generated tokens',
  prompt_tokens: 'Prompt tokens',
  tps: 'TPS',
  text_regions: 'Text regions',
  real_time_factor: 'RTF',
  sample_count: 'Samples',
  duration_ms: 'Duration',
  backend: 'Backend',
  platform: 'Platform',
  wall_time_ms: 'Wall time',
  encoder_time_ms: 'Encoder time',
  decoder_time_ms: 'Decoder time',
  audio_duration_ms: 'Audio duration',
  rtf_p50: 'P50 RTF',
  rtf_p95: 'P95 RTF',
  cold_rtf: 'Cold RTF',
  model_load_ms: 'Load time',
  ttfa_ms: 'TTFA',
  inter_chunk_p95_ms: 'Inter-chunk P95'
}

function metricLabel (key) {
  return METRIC_LABELS[key] || key
}

function formatMetricValue (key, value) {
  if (value === null || value === undefined) return '-'
  if (key.endsWith('_ms')) return `${Math.round(value)}ms`
  if (key === 'tps') return `${value.toFixed(2)} t/s`
  if (key === 'real_time_factor' || key === 'rtf_p50' || key === 'rtf_p95' || key === 'cold_rtf') {
    return value.toFixed(4)
  }
  if (Number.isInteger(value)) return String(value)
  return value.toFixed(2)
}

// ---------------------------------------------------------------------------
// Markdown generation
// ---------------------------------------------------------------------------

/**
 * Generates a markdown report matching the spreadsheet format.
 *
 * @param {Object} aggregated - Output of aggregateReports()
 * @returns {string}
 */

function formatQualityValue (key, value) {
  if (value === null || value === undefined) return '-'
  if (['cer', 'wer', 'word_recognition_rate', 'keyword_detection_rate', 'key_value_accuracy', 'chrfpp'].includes(key)) {
    return (value * 100).toFixed(1) + '%'
  }
  if (Number.isInteger(value)) return String(value)
  return value.toFixed(2)
}

function _parseTestEp (fullName) {
  const m = fullName.match(/^(.*?)\s*\[(CPU|GPU)\]\s*$/)
  if (m) return { base: m[1].trim(), ep: m[2].toUpperCase() }
  return { base: fullName, ep: '' }
}

function _shortDeviceName (name) {
  return name
    .replace(/^Samsung Galaxy\s*/i, '')
    .replace(/^Google\s*/i, '')
    .replace(/^Apple\s*/i, '')
    .replace(/-xlarge/g, '')
    .replace(/^GitHub Actions\s+\d+$/i, name)
}

// QVAC-17830: same column list writeStepSummary() uses for vision
// addons in scripts/test-utils/performance-reporter.js. The combined
// markdown report rebuilds this table per device so mobile runs that
// can't write to GITHUB_STEP_SUMMARY (they execute on Device Farm, not
// on the GitHub runner) still surface a detailed table alongside the
// desktop ones in the combined summary.
const _VISION_DETAIL_COLUMNS = [
  { key: 'backend', label: 'Backend' },
  { key: 'platform', label: 'Platform' },
  { key: 'total_time_ms', label: 'Total Time (ms)' },
  { key: 'prefill_time_ms', label: 'Prefill (ms)' },
  { key: 'decode_time_ms', label: 'Decode (ms)' },
  { key: 'vision_encode_time_ms', label: 'Vision Enc (ms)' },
  { key: 'ttft_ms', label: 'TTFT (ms)' },
  { key: 'generated_tokens', label: 'Gen Tokens' },
  { key: 'prompt_tokens', label: 'Prompt Tokens' },
  { key: 'tps', label: 'TPS' }
]

// QVAC-17830: detail-table cell formatter. Numeric cells render as
// `<mean> ±<std>` to match the squashed mini-tables — that way the
// std the user sees in the rollup is also visible per metric in the
// detail breakdown. Token-count columns (generated_tokens /
// prompt_tokens) stay as bare integers because deterministic
// generation makes `±0` noise on every row.
const _INTEGER_DETAIL_KEYS = new Set(['generated_tokens', 'prompt_tokens'])

function _formatDetailCell (key, summary, categoricalVal) {
  if (categoricalVal != null && categoricalVal !== '') return String(categoricalVal)
  if (!summary || summary.mean == null) return '-'
  const m = summary.mean
  const s = summary.std == null ? 0 : summary.std
  if (_INTEGER_DETAIL_KEYS.has(key)) return String(Math.round(m))
  if (key.endsWith('_ms')) return `${Math.round(m)} \u00b1${Math.round(s)}`
  if (key === 'tps') return `${m.toFixed(2)} \u00b1${s.toFixed(2)}`
  if (Number.isInteger(m) && Number.isInteger(s)) return `${m} \u00b1${s}`
  return `${m.toFixed(2)} \u00b1${s.toFixed(2)}`
}

/**
 * Per-device detail table (one row per test) matching the
 * writeStepSummary() layout used by desktop matrix legs. When rendered
 * into the combined step summary this gives every device — mobile
 * included — the same detail breakdown without requiring a
 * GITHUB_STEP_SUMMARY write from inside the Device Farm container.
 */
// QVAC-17830: stable display order for the scenario partitions in
// the per-device detail tables. Anything not in this list falls back
// to alphabetical order after the known scenarios.
const _SCENARIO_ORDER = ['image', 'tool-calling', 'bitnet', 'default']

function _scenarioLabel (scn) {
  if (!scn || scn === 'default') return 'default'
  return scn
}

function _sortedScenarios (scnSet) {
  const known = []
  const extras = []
  for (const scn of scnSet) {
    if (_SCENARIO_ORDER.includes(scn)) known.push(scn)
    else extras.push(scn)
  }
  known.sort((a, b) => _SCENARIO_ORDER.indexOf(a) - _SCENARIO_ORDER.indexOf(b))
  extras.sort()
  return [...known, ...extras]
}

function _groupTestsByScenario (testNames, scenarioMapForDevice) {
  const buckets = {}
  for (const t of testNames) {
    const scn = (scenarioMapForDevice && scenarioMapForDevice[t]) || 'default'
    if (!buckets[scn]) buckets[scn] = []
    buckets[scn].push(t)
  }
  for (const k of Object.keys(buckets)) buckets[k].sort()
  return buckets
}

function generateDeviceDetailTables (aggregated, addonType) {
  if (addonType !== 'vision') return ''

  const lines = []
  const {
    devices,
    device_meta: deviceMeta = {},
    categorical = {},
    scenarios = {},
    addon,
    run_numbers: runNumbers = []
  } = aggregated
  const deviceNames = Object.keys(devices)
  if (!deviceNames.length) return ''

  for (const devName of deviceNames) {
    const tests = devices[devName] || {}
    const testNames = Object.keys(tests)
    if (!testNames.length) continue

    const meta = deviceMeta[devName] || {}
    const platformArch = meta.platform && meta.arch
      ? `${meta.platform}/${meta.arch}`
      : meta.platform || '-'
    const runLabel = runNumbers.length ? runNumbers.join(', ') : 'local'

    // QVAC-17830: previously every device used the same `### Performance: <addon>`
    // header, which GitHub's step-summary renderer collapses into a single
    // anchor — making it hard to find mobile detail tables when scrolling
    // past a long desktop list. Use the device name as the heading so each
    // section gets its own anchor + TOC entry.
    lines.push(`### ${devName} \u2014 ${addon} (${platformArch})`)
    lines.push('')
    const subline = [`Run: ${runLabel}`]
    if (meta.gpu) subline.push(`GPU: ${meta.gpu}`)
    lines.push(`> ${subline.join(' | ')}`)
    lines.push('')

    const buckets = _groupTestsByScenario(testNames, scenarios[devName])
    const orderedScenarios = _sortedScenarios(Object.keys(buckets))
    const showScenarioHeading = orderedScenarios.length > 1 ||
      (orderedScenarios.length === 1 && orderedScenarios[0] !== 'default')

    for (const scn of orderedScenarios) {
      if (showScenarioHeading) {
        lines.push(`#### ${_scenarioLabel(scn)}`)
        lines.push('')
      }

      // Follow-up to QVAC-17830: emit a Model column when any row in
      // this scenario has a model id stashed on the categorical map.
      // Drop it when no row sets one so existing reports stay
      // pixel-identical for addons that haven't started plumbing it.
      const scnHasModel = buckets[scn].some(name => {
        const c = (categorical[devName] && categorical[devName][name]) || {}
        return Boolean(c.model)
      })
      const header = ['Test']
      if (scnHasModel) header.push('Model')
      header.push('EP', ..._VISION_DETAIL_COLUMNS.map(c => c.label))
      lines.push('| ' + header.join(' | ') + ' |')
      lines.push('| ' + header.map(() => '---').join(' | ') + ' |')

      for (const testName of buckets[scn]) {
        const metrics = tests[testName] || {}
        const cats = (categorical[devName] && categorical[devName][testName]) || {}
        const ep = cats.execution_provider || '-'
        const row = [testName]
        if (scnHasModel) row.push(cats.model || '-')
        row.push(ep)
        for (const col of _VISION_DETAIL_COLUMNS) {
          row.push(_formatDetailCell(col.key, metrics[col.key], cats[col.key]))
        }
        lines.push('| ' + row.join(' | ') + ' |')
      }
      lines.push('')
    }
  }

  return lines.join('\n')
}

function generateMarkdownReport (aggregated, opts) {
  const options = opts || {}
  const lines = []
  const { addon, generated_at, run_numbers, devices, quality, device_meta: deviceMeta = {} } = aggregated
  const iterCount = _maxIterationCount(devices)

  // Follow-up to QVAC-17830 (Olya, 17 May): the per-device detail block
  // already shows `GPU: ...` next to each device heading, but the
  // cross-device mean comparison tables (PART A) only used the bare
  // device short name as the column header. Annotate the header with
  // the GPU on a second line when meta.gpu is populated so reviewers
  // can tell which GPU produced each column without scrolling down to
  // the per-device detail block. `<br>` is honoured inside GitHub
  // Markdown table cells. Device name stays primary; GPU is appended
  // below it. Falls back to plain device name when meta.gpu is null
  // (mobile Device Farm rows, headless Linux runners, etc.) so the
  // pre-change layout is preserved for those columns.
  function _columnHeader (devName) {
    const short = _shortDeviceName(devName)
    const gpu = deviceMeta[devName] && deviceMeta[devName].gpu
    return gpu ? `${short}<br>${gpu}` : short
  }

  lines.push(`## ${addon} Performance Report`)
  lines.push(`Generated: ${generated_at} | CI Runs: ${run_numbers.join(', ')} | Iterations: ${iterCount}`)
  lines.push('')
  // QVAC-17830: terse one-liner so reviewers don't read dashes as
  // broken data. Per-scenario column filtering already drops devices
  // with zero data in a scenario; the dashes that remain are
  // intentional test gates (model too heavy for mobile, no GPU on
  // that runner, etc.).
  lines.push('> _`-` = not run on this device._')
  lines.push('')

  const deviceNames = Object.keys(devices)
  if (!deviceNames.length) return lines.join('\n') + '\n'

  const shortNames = deviceNames.map(_columnHeader)

  const allTests = new Set()
  for (const tests of Object.values(devices)) {
    for (const t of Object.keys(tests)) allTests.add(t)
  }

  const parsed = [...allTests].map(n => ({ full: n, ..._parseTestEp(n) }))
  const epOrder = { CPU: 0, GPU: 1, '': 2 }
  parsed.sort((a, b) => {
    if (a.base !== b.base) return a.base.localeCompare(b.base)
    return (epOrder[a.ep] || 0) - (epOrder[b.ep] || 0)
  })

  const hasEp = parsed.some(p => p.ep !== '')

  // QVAC-17830: squashed step-summary layout — one mini-table per
  // headline metric, each row=test, col=device, cell="mean ±std".
  // Per the latest review feedback we surface the full breakdown
  // (Total / Prefill / Decode / Vision Encode / TTFT / TPS) instead
  // of just Total/TTFT/TPS so the cross-platform comparison shows
  // the same numbers as the per-device detail tables. Each table
  // is suppressed when EVERY cell is null (e.g. vision_encode_time_ms
  // is currently null everywhere until the native timer lands —
  // Asana 1214371583877702 — so its table won't render yet) and
  // is also suppressed for OCR reports that never produce TTFT/TPS.
  const SUMMARY_METRICS = [
    { key: 'total_time_ms', unit: 'ms', round: true, label: 'Mean Total Time (ms)' },
    { key: 'prefill_time_ms', unit: 'ms', round: true, label: 'Mean Prefill (ms)' },
    { key: 'decode_time_ms', unit: 'ms', round: true, label: 'Mean Decode (ms)' },
    { key: 'vision_encode_time_ms', unit: 'ms', round: true, label: 'Mean Vision Encode (ms)' },
    { key: 'ttft_ms', unit: 'ms', round: true, label: 'Mean TTFT (ms)' },
    { key: 'tps', unit: '', round: false, label: 'Mean TPS' }
  ]

  const scenarioMap = aggregated.scenarios || {}

  function _scenarioFor (devName, testFull) {
    return (scenarioMap[devName] && scenarioMap[devName][testFull]) || 'default'
  }

  // QVAC-18298: resolve the model id recorded for a test (from the first
  // device that has it) so the summary tables can show a Model column. Lets
  // rows whose label omits the model (e.g. the SmolVLM2 `[elephant]` image
  // rows) still surface which weights produced the numbers, consistent with
  // the VLM rows whose label already carries the model.
  const categoricalMap = aggregated.categorical || {}
  function _modelFor (testFull) {
    for (const devName of deviceNames) {
      const c = categoricalMap[devName] && categoricalMap[devName][testFull]
      if (c && c.model) return c.model
    }
    return null
  }

  function _formatMeanStd (summary, unit, round) {
    if (!summary || summary.mean == null) return '-'
    const m = round ? Math.round(summary.mean) : summary.mean.toFixed(2)
    const s = round ? Math.round(summary.std) : summary.std.toFixed(2)
    return `${m} \u00b1${s}${unit}`
  }

  // Group tests by scenario so the squashed summary has the same
  // implementation breakdown as the HTML detail tables. Picks the
  // scenario from the FIRST device that recorded the test (sibling
  // legs always share scenario for the same test name).
  const testScenario = {}
  for (const t of parsed) {
    let scn = 'default'
    for (const devName of deviceNames) {
      if (devices[devName] && devices[devName][t.full]) {
        scn = _scenarioFor(devName, t.full)
        if (scn !== 'default') break
      }
    }
    testScenario[t.full] = scn
  }
  const scenariosSeen = _sortedScenarios([...new Set(parsed.map(t => testScenario[t.full]))])
  const showScenarioHeading = scenariosSeen.length > 1 ||
    (scenariosSeen.length === 1 && scenariosSeen[0] !== 'default')

  for (const metricSpec of SUMMARY_METRICS) {
    const hasAnyData = parsed.some(t => deviceNames.some(d => {
      const m = devices[d] && devices[d][t.full] && devices[d][t.full][metricSpec.key]
      return m && m.mean != null
    }))
    if (!hasAnyData) continue

    lines.push(`### ${metricSpec.label}`)
    lines.push('')

    for (const scn of scenariosSeen) {
      const scopedTests = parsed.filter(t => testScenario[t.full] === scn)
      if (!scopedTests.length) continue

      // QVAC-17830: per-scenario column filtering. The cross-platform
      // table previously rendered ALL device columns for every
      // scenario block, so e.g. the bitnet block (Android-only by
      // design — see bitnet.test.js `skip: !isAndroid`) showed 7
      // empty desktop/iOS columns of dashes, which made the report
      // look broken when it was actually intentional. Drop columns
      // that have zero data in this scenario × metric.
      const scopedDeviceNames = deviceNames.filter(d => {
        return scopedTests.some(t => {
          const m = devices[d] && devices[d][t.full] && devices[d][t.full][metricSpec.key]
          return m && m.mean != null
        })
      })
      if (!scopedDeviceNames.length) continue

      const scopedShortNames = scopedDeviceNames.map(_columnHeader)

      if (showScenarioHeading) {
        lines.push(`#### ${_scenarioLabel(scn)}`)
        lines.push('')
      }

      // QVAC-18298: add a Model column when any test in this scenario has a
      // recorded model, so rows whose label omits the model (e.g. SmolVLM2
      // `[elephant]`) still show which weights produced the numbers next to
      // the VLM rows that carry it in the label. Column is dropped entirely
      // for scenarios/addons with no model data, so existing reports are
      // unchanged.
      const scnHasModel = scopedTests.some(t => Boolean(_modelFor(t.full)))

      const perfHeader = hasEp ? ['Test', 'EP'] : ['Test']
      if (scnHasModel) perfHeader.push('Model')
      for (const sn of scopedShortNames) perfHeader.push(sn)
      lines.push('| ' + perfHeader.join(' | ') + ' |')
      lines.push('| ' + perfHeader.map(() => '---').join(' | ') + ' |')

      for (const t of scopedTests) {
        const epCell = hasEp ? (t.ep ? `**${t.ep}**` : '-') : null
        const cells = hasEp ? [t.base, epCell] : [t.full]
        if (scnHasModel) cells.push(_modelFor(t.full) || '-')
        for (const devName of scopedDeviceNames) {
          const metrics = devices[devName] && devices[devName][t.full]
          cells.push(_formatMeanStd(metrics && metrics[metricSpec.key], metricSpec.unit, metricSpec.round))
        }
        lines.push('| ' + cells.join(' | ') + ' |')
      }
      lines.push('')
    }
  }

  // --- Quality Summary (combined) ---
  if (quality && Object.keys(quality).length > 0) {
    const hasQualityData = Object.values(quality).some(tests =>
      Object.values(tests).some(m => Object.keys(m).length > 0)
    )

    if (hasQualityData) {
      lines.push('---')
      lines.push('')
      lines.push('### Quality Summary')
      lines.push('')

      const qKeys = ['cer', 'wer', 'keyword_detection_rate', 'key_value_accuracy', 'chrfpp']
      const qShort = { cer: 'CER', wer: 'WER', keyword_detection_rate: 'KW', key_value_accuracy: 'KV', chrfpp: 'chrF++' }

      const qHeader = hasEp ? ['Test', 'EP'] : ['Test']
      for (const sn of shortNames) {
        for (const qk of qKeys) qHeader.push(`${sn} ${qShort[qk]}`)
      }
      lines.push('| ' + qHeader.join(' | ') + ' |')
      lines.push('| ' + qHeader.map(() => '---').join(' | ') + ' |')

      for (const t of parsed) {
        const cells = hasEp ? [t.base, `**${t.ep}**`] : [t.full]
        for (const devName of deviceNames) {
          const testQ = quality[devName] && quality[devName][t.full]
          for (const qk of qKeys) {
            if (testQ && testQ[qk]) {
              cells.push(formatQualityValue(qk, testQ[qk].mean))
            } else {
              cells.push('-')
            }
          }
        }
        lines.push('| ' + cells.join(' | ') + ' |')
      }
      lines.push('')
    }
  }

  if (options.includeDeviceDetails) {
    const detail = generateDeviceDetailTables(aggregated, options.addonType || 'vision')
    if (detail) {
      lines.push('---')
      lines.push('')
      lines.push('### Per-Device Detail')
      lines.push('')
      lines.push(detail)
    }
  }

  return lines.join('\n') + '\n'
}

// ---------------------------------------------------------------------------
// Aggregation logic
// ---------------------------------------------------------------------------

/**
 * Aggregates multiple performance-report.json files into a comparison structure.
 *
 * @param {Object[]} reports - Array of parsed JSON reports
 * @returns {Object} Aggregated result
 */
function aggregateReports (reports) {
  if (!reports.length) {
    return { addon: 'unknown', devices: {}, run_numbers: [], quality: {}, device_meta: {}, categorical: {}, scenarios: {} }
  }

  const addon = reports[0].addon
  const runNumbers = [...new Set(reports.map(r => r.run_number).filter(Boolean))]

  const deviceMap = {}
  const qualityMap = {}
  const imagePathMap = {}
  // Per-device metadata (platform / arch) harvested from the first
  // report that landed under that device name. Used by the per-device
  // detail tables in the combined summary.
  const deviceMeta = {}
  // Categorical metrics (e.g. backend, platform, status) — numeric
  // summarize() drops these because typeof v !== 'number'. We keep the
  // most recent string value per [device][test][metric] so the per-
  // device detail table can render the real backend / platform / status
  // instead of the blank "-" produced by summarize on strings.
  const categorical = {}
  // QVAC-17830: scenarioMap[device][test] = 'image' | 'bitnet' |
  // 'tool-calling' | 'default'. Lets the per-device detail tables
  // partition rows by implementation so a single combined report can
  // surface "image" and "tool-calling" numbers side by side without
  // mixing them into one giant table.
  const scenarioMap = {}
  // QVAC-17830: dedupe by (device, test, run_number). The combined
  // report folds sibling matrix legs (linux-x64-u22-gpu+linux-x64-u24-gpu,
  // linux-arm64-u22+linux-arm64-u24) onto one device name so users see
  // ONE column per physical platform. Without dedupe each shared
  // [test] [CPU] row gets 3 iters from each leg → iteration count
  // explodes to 6 ("Run 4 / 5 / 6" headers). First-leg-wins per
  // (device, test, run_number) keeps it at 3 while still picking up
  // the GPU leg's exclusive [GPU] rows. The weekly aggregator is
  // unaffected: it accumulates across DIFFERENT run_numbers.
  const seenLeg = {}

  for (const report of reports) {
    const deviceName = report.device ? report.device.name : 'unknown'
    const reportRun = report.run_number || 'local'

    if (!deviceMap[deviceName]) deviceMap[deviceName] = {}
    if (!qualityMap[deviceName]) qualityMap[deviceName] = {}
    if (!categorical[deviceName]) categorical[deviceName] = {}
    if (!scenarioMap[deviceName]) scenarioMap[deviceName] = {}
    if (!seenLeg[deviceName]) seenLeg[deviceName] = {}
    if (!deviceMeta[deviceName] && report.device) {
      deviceMeta[deviceName] = {
        name: report.device.name,
        platform: report.device.platform || null,
        arch: report.device.arch || null,
        os_version: report.device.os_version || null,
        gpu: report.device.gpu || null,
        runner: report.device.runner || null
      }
    } else if (deviceMeta[deviceName] && report.device && report.device.gpu && !deviceMeta[deviceName].gpu) {
      // Sibling matrix legs may report different gpu strings — keep
      // the first non-null one we see; folded sibling legs share one
      // device column and surface the GPU label.
      deviceMeta[deviceName].gpu = report.device.gpu
    }

    // Per-test "claim" set for THIS report. Once a sibling leg has
    // already contributed a (device, test) pair for this run_number we
    // skip the current report's rows for that pair — but within a
    // single report we still keep ALL iterations (e.g. PERF_RUNS=3).
    const claimedThisReport = new Set()

    for (const result of (report.results || [])) {
      const testKey = result.test
      const legKey = `${testKey}::${reportRun}`
      const alreadyClaimed = seenLeg[deviceName][legKey]
      if (alreadyClaimed && !claimedThisReport.has(legKey)) continue
      claimedThisReport.add(legKey)
      seenLeg[deviceName][legKey] = true

      if (!deviceMap[deviceName][testKey]) deviceMap[deviceName][testKey] = {}
      if (!categorical[deviceName][testKey]) categorical[deviceName][testKey] = {}

      if (result.image_path && !imagePathMap[testKey]) {
        imagePathMap[testKey] = result.image_path
      }

      if (result.execution_provider != null) {
        categorical[deviceName][testKey].execution_provider = String(result.execution_provider)
      }

      // Follow-up to QVAC-17830: stash the model id on the categorical
      // map so per-device detail tables can render a Model column.
      // First non-null wins per (device, test) so sibling matrix legs
      // that share the same test all converge on the same label.
      if (result.model != null && !categorical[deviceName][testKey].model) {
        categorical[deviceName][testKey].model = String(result.model)
      }

      // First non-default scenario wins per (device, test). Sibling
      // matrix legs always tag the same test with the same scenario,
      // so this is stable; if the field is missing or 'default' from
      // an older report we won't overwrite a real one set later.
      const scn = result.scenario && String(result.scenario)
      if (scn && (!scenarioMap[deviceName][testKey] || scenarioMap[deviceName][testKey] === 'default')) {
        scenarioMap[deviceName][testKey] = scn
      }

      for (const [metricKey, value] of Object.entries(result.metrics || {})) {
        if (value === null || value === undefined) continue
        if (typeof value === 'number') {
          if (!deviceMap[deviceName][testKey][metricKey]) {
            deviceMap[deviceName][testKey][metricKey] = []
          }
          deviceMap[deviceName][testKey][metricKey].push(value)
        } else {
          categorical[deviceName][testKey][metricKey] = String(value)
        }
      }

      if (result.quality) {
        if (!qualityMap[deviceName][testKey]) qualityMap[deviceName][testKey] = {}
        for (const [qKey, qVal] of Object.entries(result.quality)) {
          if (qVal === null || qVal === undefined || typeof qVal !== 'number') continue
          if (!qualityMap[deviceName][testKey][qKey]) {
            qualityMap[deviceName][testKey][qKey] = []
          }
          qualityMap[deviceName][testKey][qKey].push(qVal)
        }
      }
    }
  }

  const summarized = {}
  for (const [dev, tests] of Object.entries(deviceMap)) {
    summarized[dev] = {}
    for (const [test, metrics] of Object.entries(tests)) {
      summarized[dev][test] = {}
      for (const [key, values] of Object.entries(metrics)) {
        summarized[dev][test][key] = summarize(values)
      }
    }
  }

  const qualitySummarized = {}
  for (const [dev, tests] of Object.entries(qualityMap)) {
    qualitySummarized[dev] = {}
    for (const [test, metrics] of Object.entries(tests)) {
      qualitySummarized[dev][test] = {}
      for (const [key, values] of Object.entries(metrics)) {
        qualitySummarized[dev][test][key] = summarize(values)
      }
    }
  }

  const qualityDetails = _collectQualityDetails(reports)

  return {
    addon,
    generated_at: new Date().toISOString(),
    run_numbers: runNumbers,
    devices: summarized,
    quality: qualitySummarized,
    image_paths: imagePathMap,
    quality_details: qualityDetails,
    device_meta: deviceMeta,
    categorical,
    scenarios: scenarioMap
  }
}

// ---------------------------------------------------------------------------
// Quality detail collection
// ---------------------------------------------------------------------------

function _tokenizeForPreview (text) {
  return String(text)
    .replace(/\r\n/g, '\n')
    .replace(/[\t\v\f]/g, ' ')
    .replace(/ {2,}/g, ' ')
    .trim()
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
}

function _findTestImage (testName, imageDataCache) {
  if (!imageDataCache || !Object.keys(imageDataCache).length) return null
  if (imageDataCache[testName]) return imageDataCache[testName]
  for (const [key, src] of Object.entries(imageDataCache)) {
    const baseA = testName.replace(/\s*\[(CPU|GPU)\]/gi, '').trim()
    const baseB = key.replace(/\s*\[(CPU|GPU)\]/gi, '').trim()
    if (baseA === baseB) return src
  }
  return null
}

function _collectQualityDetails (reports) {
  const details = {}
  const seen = new Set()

  for (const report of reports) {
    const deviceName = report.device ? report.device.name : 'unknown'
    if (!details[deviceName]) details[deviceName] = {}

    for (const result of (report.results || [])) {
      const testKey = result.test
      const dedup = `${deviceName}|${testKey}`
      if (seen.has(dedup)) continue
      seen.add(dedup)

      if (!result.quality) continue

      const entry = {}

      if (result.quality.keywords_missing && result.quality.keywords_missing.length > 0) {
        entry.keywords_missing = result.quality.keywords_missing
      }

      if (result.quality.key_values_unmatched && result.quality.key_values_unmatched.length > 0) {
        entry.kv_unmatched = result.quality.key_values_unmatched.map(u => u.key || u)
        entry.kv_unmatched_detail = result.quality.key_values_unmatched.map(u => ({
          key: u.key,
          value: u.value,
          key_found: u.key_found !== undefined ? u.key_found : null,
          value_found: u.value_found !== undefined ? u.value_found : null
        }))
      }

      if (result.output) {
        try {
          const texts = JSON.parse(result.output)
          if (Array.isArray(texts)) {
            const sorted = _tokenizeForPreview(texts.join(' ')).sort().join(' ')
            entry.hypothesis_preview = sorted.substring(0, 200) + (sorted.length > 200 ? '...' : '')
          }
        } catch (_) {}
      }

      if (Object.keys(entry).length > 0) {
        details[deviceName][testKey] = entry
      }
    }
  }

  return details
}

// ---------------------------------------------------------------------------
// HTML generation
// ---------------------------------------------------------------------------

const HIGHER_IS_BETTER = new Set(['tps', 'generated_tokens', 'prompt_tokens', 'text_regions', 'sample_count'])

function heatColor (value, min, max, higherIsBetter) {
  if (min === max) return 'transparent'
  const ratio = (value - min) / (max - min)
  const t = higherIsBetter ? ratio : 1 - ratio
  const r = Math.round(220 - t * 180)
  const g = Math.round(80 + t * 140)
  const b = Math.round(80)
  return `rgba(${r}, ${g}, ${b}, 0.15)`
}

function barWidth (value, max) {
  if (!max) return 0
  return Math.round((value / max) * 100)
}

function escapeHtml (str) {
  return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

/**
 * Determines the maximum number of iterations (values array length) across
 * all metrics in the aggregated data. When tests are repeated N times within
 * a single CI run, values.length == N even though run_numbers has only one entry.
 */
function _maxIterationCount (devices) {
  let max = 0
  for (const tests of Object.values(devices)) {
    for (const metrics of Object.values(tests)) {
      for (const summary of Object.values(metrics)) {
        if (summary && summary.values && summary.values.length > max) {
          max = summary.values.length
        }
      }
    }
  }
  return max || 1
}

/**
 * Builds column headers for iterations. When multiple iterations exist within
 * one CI run, labels them "Run 1", "Run 2", ... so each value is visible.
 * When iterations match run_numbers 1:1, uses the original "Run #NNN" format.
 */
function _iterationHeaders (count, runNumbers) {
  if (count === runNumbers.length) {
    return runNumbers.map(n => `<th>Run #${n}</th>`).join('')
  }
  const hdrs = []
  for (let i = 1; i <= count; i++) {
    hdrs.push(`<th>Run ${i}</th>`)
  }
  return hdrs.join('')
}

function _mdIterationHeaders (count, runNumbers) {
  if (count === runNumbers.length) {
    return runNumbers.map(n => `Run #${n}`)
  }
  const hdrs = []
  for (let i = 1; i <= count; i++) {
    hdrs.push(`Run ${i}`)
  }
  return hdrs
}

/**
 * Builds the per-device "row-per-test" detail section in HTML. Mirrors the
 * markdown `generateDeviceDetailTables` output — same columns, same ordering
 * — so the combined HTML report has parity with the GitHub step summary.
 * Each device gets one section; each test is one row with Backend / Platform
 * / Total Time / .../ Status columns taken from numeric means + preserved
 * categorical values.
 *
 * Without this block mobile rows render as blank categorical cells in the
 * HTML since `generateStepSummary()` runs per-device on the GitHub runner
 * and Device Farm containers can't write to GITHUB_STEP_SUMMARY.
 */
function _buildHtmlDetailSections (aggregated, addonType) {
  if (addonType !== 'vision') return ''
  const { devices, device_meta: deviceMeta = {}, categorical = {}, scenarios = {}, addon, run_numbers: runNumbers = [] } = aggregated
  const deviceNames = Object.keys(devices)
  if (!deviceNames.length) return ''

  let html = ''
  for (const devName of deviceNames) {
    const tests = devices[devName] || {}
    const testNames = Object.keys(tests)
    if (!testNames.length) continue

    const meta = deviceMeta[devName] || {}
    const platformArch = meta.platform && meta.arch
      ? `${meta.platform}/${meta.arch}`
      : meta.platform || '-'
    const runLabel = runNumbers.length ? runNumbers.map(n => '#' + n).join(', ') : 'local'
    const gpuLabel = meta.gpu ? ` \u00b7 GPU: ${meta.gpu}` : ''

    const buckets = _groupTestsByScenario(testNames, scenarios[devName])
    const orderedScenarios = _sortedScenarios(Object.keys(buckets))
    const showScenarioHeading = orderedScenarios.length > 1 ||
      (orderedScenarios.length === 1 && orderedScenarios[0] !== 'default')

    let scenarioBlocks = ''
    for (const scn of orderedScenarios) {
      // Follow-up to QVAC-17830: emit a Model column only when any row
      // in this scenario has a model id. Mirrors the markdown branch
      // above so the HTML + Markdown artifacts stay in lockstep.
      const scnHasModel = buckets[scn].some(name => {
        const c = (categorical[devName] && categorical[devName][name]) || {}
        return Boolean(c.model)
      })
      const headerLabels = ['Test']
      if (scnHasModel) headerLabels.push('Model')
      headerLabels.push('EP', ..._VISION_DETAIL_COLUMNS.map(c => c.label))
      const headerCells = headerLabels
        .map(h => `<th>${escapeHtml(h)}</th>`).join('')

      let bodyRows = ''
      for (const testName of buckets[scn]) {
        const metrics = tests[testName] || {}
        const cats = (categorical[devName] && categorical[devName][testName]) || {}
        const ep = cats.execution_provider || '-'
        const cells = [escapeHtml(testName)]
        if (scnHasModel) cells.push(escapeHtml(cats.model || '-'))
        cells.push(escapeHtml(ep))
        for (const col of _VISION_DETAIL_COLUMNS) {
          cells.push(escapeHtml(_formatDetailCell(col.key, metrics[col.key], cats[col.key])))
        }
        bodyRows += '<tr>' + cells.map(c => `<td>${c}</td>`).join('') + '</tr>'
      }

      const scenarioHeading = showScenarioHeading
        ? `<h3 class="scenario-name">${escapeHtml(_scenarioLabel(scn))}</h3>`
        : ''

      scenarioBlocks += `
        <div class="test-block">
          ${scenarioHeading}
          <table class="detail-table">
            <thead><tr>${headerCells}</tr></thead>
            <tbody>${bodyRows}</tbody>
          </table>
        </div>`
    }

    html += `
    <section class="device-card detail-card">
      <h2 class="device-name">${escapeHtml(devName)} <span class="detail-sub">(${escapeHtml(platformArch)} \u00b7 Run ${escapeHtml(runLabel)} \u00b7 ${escapeHtml(addon)}${escapeHtml(gpuLabel)})</span></h2>
${scenarioBlocks}
    </section>`
  }

  return html
}

/**
 * Generates a self-contained HTML performance report.
 *
 * @param {Object} aggregated - Output of aggregateReports()
 * @param {Object} [opts]
 * @param {boolean} [opts.includeDeviceDetails] - Append per-device row-per-test summary tables (vision addons only)
 * @param {string} [opts.addonType] - Addon type ('vision' enables the detail tables)
 * @returns {string} Complete HTML document
 */
function generateHtmlReport (aggregated, opts) {
  const options = opts || {}
  const { addon, generated_at, run_numbers, devices, quality, image_paths } = aggregated
  const timestamp = new Date(generated_at).toLocaleString('en-US', {
    dateStyle: 'medium',
    timeStyle: 'short'
  })

  const iterationCount = _maxIterationCount(devices)

  const imageDataCache = {}
  if (image_paths) {
    const fs = require('fs')
    const path = require('path')
    const fallbackDir = path.resolve(__dirname, '..', '..', 'packages', 'ocr-onnx', 'test', 'images')
    for (const [testKey, imgPath] of Object.entries(image_paths)) {
      try {
        let resolved = path.resolve(imgPath)
        if (!fs.existsSync(resolved)) {
          resolved = path.join(fallbackDir, path.basename(imgPath))
        }
        if (fs.existsSync(resolved)) {
          const ext = path.extname(resolved).toLowerCase().replace('.', '')
          const mime = ext === 'jpg' ? 'image/jpeg' : `image/${ext}`
          const b64 = fs.readFileSync(resolved).toString('base64')
          imageDataCache[testKey] = `data:${mime};base64,${b64}`
        }
      } catch (_) {}
    }
  }

  let deviceCards = ''

  for (const [deviceName, tests] of Object.entries(devices)) {
    let tables = ''

    for (const [testName, metrics] of Object.entries(tests)) {
      const metricKeys = Object.keys(metrics).filter(k => metrics[k])
      if (!metricKeys.length) continue

      let rows = ''
      for (const key of metricKeys) {
        const summary = metrics[key]
        if (!summary) continue
        const hib = HIGHER_IS_BETTER.has(key)

        let valueCells = ''
        for (let i = 0; i < iterationCount; i++) {
          const v = summary.values[i]
          if (v === undefined) {
            valueCells += '<td class="val">-</td>'
            continue
          }
          const bg = heatColor(v, summary.min, summary.max, hib)
          const pct = barWidth(v, summary.max)
          valueCells += `<td class="val" style="background:${bg}">
            <div class="bar-wrap"><div class="bar" style="width:${pct}%"></div></div>
            <span class="num">${escapeHtml(formatMetricValue(key, v))}</span>
          </td>`
        }

        const meanBg = 'rgba(100, 140, 200, 0.1)'
        rows += `<tr>
          <td class="metric-name">${escapeHtml(metricLabel(key))}</td>
          ${valueCells}
          <td class="val mean-col" style="background:${meanBg}">
            <span class="num">${escapeHtml(formatMetricValue(key, summary.mean))}</span>
          </td>
          <td class="val std-col">&#177;${escapeHtml(formatMetricValue(key, summary.std))}</td>
        </tr>`
      }

      const iterHeaders = _iterationHeaders(iterationCount, run_numbers)

      tables += `
      <div class="test-block">
        <h3 class="test-name">${escapeHtml(testName)}</h3>
        <table>
          <thead>
            <tr>
              <th class="metric-col">Metric</th>
              ${iterHeaders}
              <th class="mean-hdr">Mean</th>
              <th class="std-hdr">Std Dev</th>
            </tr>
          </thead>
          <tbody>${rows}</tbody>
        </table>
      </div>`
    }

    deviceCards += `
    <section class="device-card">
      <h2 class="device-name">${escapeHtml(deviceName)}</h2>
      ${tables}
    </section>`
  }

  const detailSections = options.includeDeviceDetails
    ? _buildHtmlDetailSections(aggregated, options.addonType || 'vision')
    : ''

  let qualitySection = ''
  const qualityDetails = aggregated.quality_details || {}

  if (quality && Object.keys(quality).length > 0) {
    const qualityKeys = ['cer', 'wer', 'word_recognition_rate', 'keyword_detection_rate', 'key_value_accuracy']
    const qLabels = { cer: 'CER', wer: 'WER', word_recognition_rate: 'Word Recognition', keyword_detection_rate: 'Keyword Detection', key_value_accuracy: 'KV Accuracy' }
    const LOWER_IS_BETTER_Q = new Set(['cer', 'wer'])
    const colCount = qualityKeys.length + 1

    for (const [deviceName, tests] of Object.entries(quality)) {
      const hasData = Object.values(tests).some(m => Object.keys(m).length > 0)
      if (!hasData) continue

      const devDetails = qualityDetails[deviceName] || {}
      let qRows = ''
      for (const [testName, metrics] of Object.entries(tests)) {
        if (!Object.keys(metrics).length) continue

        let cells = ''
        for (const qk of qualityKeys) {
          const summary = metrics[qk]
          if (!summary) {
            cells += '<td class="val">-</td>'
            continue
          }
          const pct = summary.mean * 100
          const isGood = LOWER_IS_BETTER_Q.has(qk) ? pct < 30 : pct > 70
          const isBad = LOWER_IS_BETTER_Q.has(qk) ? pct > 60 : pct < 40
          const cls = isGood ? 'q-good' : isBad ? 'q-bad' : 'q-mid'
          cells += `<td class="val ${cls}">${pct.toFixed(1)}%</td>`
        }

        let imgThumb = ''
        const imgSrc = _findTestImage(testName, imageDataCache)
        if (imgSrc) {
          imgThumb = ` <img src="${imgSrc}" class="img-thumb" alt="test image" onclick="openLightbox(this.src)">`
        }

        qRows += `<tr><td class="metric-name">${escapeHtml(testName)}${imgThumb}</td>${cells}</tr>`

        const detail = devDetails[testName]
        if (detail) {
          let detailContent = ''
          if (detail.hypothesis_preview) {
            detailContent += `<div class="detail-row"><span class="detail-label">OCR output (sorted tokens):</span> <code>${escapeHtml(detail.hypothesis_preview)}</code></div>`
          }
          if (detail.keywords_missing && detail.keywords_missing.length > 0) {
            detailContent += `<div class="detail-row"><span class="detail-label">Missing keywords (${detail.keywords_missing.length}):</span> ${escapeHtml(detail.keywords_missing.join(', '))}</div>`
          }
          if (detail.kv_unmatched_detail && detail.kv_unmatched_detail.length > 0) {
            let kvTable = '<table class="misread-table"><thead><tr><th>Expected Key</th><th>Expected Value</th><th>Key Found?</th><th>Value Found?</th></tr></thead><tbody>'
            for (const u of detail.kv_unmatched_detail) {
              const kCls = u.key_found ? 'found' : 'not-found'
              const vCls = u.value_found ? 'found' : 'not-found'
              kvTable += `<tr><td>${escapeHtml(u.key)}</td><td>${escapeHtml(String(u.value))}</td><td class="${kCls}">${u.key_found ? 'Yes' : 'No'}</td><td class="${vCls}">${u.value_found ? 'Yes' : 'No'}</td></tr>`
            }
            kvTable += '</tbody></table>'
            detailContent += `<div class="detail-row"><span class="detail-label">Unmatched key-value pairs (${detail.kv_unmatched_detail.length}):</span>${kvTable}</div>`
          } else if (detail.kv_unmatched && detail.kv_unmatched.length > 0) {
            detailContent += `<div class="detail-row"><span class="detail-label">Unmatched KV keys (${detail.kv_unmatched.length}):</span> ${escapeHtml(detail.kv_unmatched.join(', '))}</div>`
          }
          if (detailContent) {
            qRows += `<tr class="detail-expand-row">
              <td colspan="${colCount}">
                <details class="quality-details">
                  <summary>Show diagnostic details</summary>
                  <div class="detail-body">${detailContent}</div>
                </details>
              </td>
            </tr>`
          }
        }
      }

      if (qRows) {
        const qHeaders = qualityKeys.map(k => `<th>${qLabels[k]}</th>`).join('')
        qualitySection += `
        <section class="device-card quality-card">
          <h2 class="device-name quality-header">Quality: ${escapeHtml(deviceName)}</h2>
          <div class="test-block">
            <table>
              <thead>
                <tr>
                  <th class="metric-col">Test</th>
                  ${qHeaders}
                </tr>
              </thead>
              <tbody>${qRows}</tbody>
            </table>
          </div>
        </section>`
      }
    }
  }

  const dataJson = JSON.stringify(aggregated, null, 2)

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(addon)} Performance Report</title>
<style>
  :root {
    --bg: #fafbfc;
    --card-bg: #ffffff;
    --border: #e1e4e8;
    --text: #24292e;
    --text-secondary: #586069;
    --accent: #0366d6;
    --bar-color: #0366d6;
    --bar-bg: #e8ecf0;
    --mean-bg: #f1f5ff;
    --header-bg: #f6f8fa;
  }

  * { margin: 0; padding: 0; box-sizing: border-box; }

  body {
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Oxygen, Ubuntu, sans-serif;
    background: var(--bg);
    color: var(--text);
    line-height: 1.5;
    padding: 2rem;
    max-width: 1400px;
    margin: 0 auto;
  }

  .report-header {
    margin-bottom: 2rem;
    padding-bottom: 1.5rem;
    border-bottom: 2px solid var(--border);
  }

  .report-header h1 {
    font-size: 1.75rem;
    font-weight: 600;
    margin-bottom: 0.5rem;
  }

  .report-meta {
    display: flex;
    gap: 1.5rem;
    flex-wrap: wrap;
    color: var(--text-secondary);
    font-size: 0.875rem;
  }

  .report-meta span {
    display: inline-flex;
    align-items: center;
    gap: 0.35rem;
  }

  .badge {
    display: inline-block;
    padding: 0.15rem 0.5rem;
    border-radius: 10px;
    font-size: 0.75rem;
    font-weight: 600;
    background: var(--accent);
    color: #fff;
  }

  .device-card {
    background: var(--card-bg);
    border: 1px solid var(--border);
    border-radius: 8px;
    margin-bottom: 1.5rem;
    overflow: hidden;
    box-shadow: 0 1px 3px rgba(0,0,0,0.04);
  }

  .device-name {
    font-size: 1.15rem;
    font-weight: 600;
    padding: 1rem 1.25rem;
    background: var(--header-bg);
    border-bottom: 1px solid var(--border);
  }

  .test-block {
    padding: 0.75rem 1.25rem 1.25rem;
    border-bottom: 1px solid var(--border);
  }

  .test-block:last-child { border-bottom: none; }

  .test-name {
    font-size: 0.9rem;
    font-weight: 600;
    color: var(--accent);
    margin-bottom: 0.5rem;
  }

  table {
    width: 100%;
    border-collapse: collapse;
    font-size: 0.825rem;
  }

  thead th {
    text-align: left;
    padding: 0.5rem 0.65rem;
    background: var(--header-bg);
    border-bottom: 2px solid var(--border);
    font-weight: 600;
    font-size: 0.75rem;
    text-transform: uppercase;
    letter-spacing: 0.03em;
    color: var(--text-secondary);
    white-space: nowrap;
  }

  .metric-col { min-width: 130px; }
  .mean-hdr, .std-hdr { white-space: nowrap; }

  tbody td {
    padding: 0.4rem 0.65rem;
    border-bottom: 1px solid #f0f0f0;
    vertical-align: middle;
  }

  tbody tr:last-child td { border-bottom: none; }
  tbody tr:hover { background: rgba(3, 102, 214, 0.03); }

  .metric-name {
    font-weight: 500;
    white-space: nowrap;
    color: var(--text);
  }

  .val {
    position: relative;
    text-align: right;
    white-space: nowrap;
    min-width: 90px;
  }

  .bar-wrap {
    position: absolute;
    bottom: 2px;
    left: 4px;
    right: 4px;
    height: 3px;
    background: var(--bar-bg);
    border-radius: 2px;
    overflow: hidden;
  }

  .bar {
    height: 100%;
    background: var(--bar-color);
    border-radius: 2px;
    transition: width 0.3s ease;
  }

  .num { position: relative; z-index: 1; }

  .mean-col { font-weight: 600; }

  .std-col {
    color: var(--text-secondary);
    font-size: 0.75rem;
  }

  .legend {
    margin-top: 2rem;
    padding: 1rem 1.25rem;
    background: var(--card-bg);
    border: 1px solid var(--border);
    border-radius: 8px;
    font-size: 0.8rem;
    color: var(--text-secondary);
  }

  .legend h4 { margin-bottom: 0.4rem; color: var(--text); }

  .color-scale {
    display: inline-flex;
    height: 12px;
    width: 120px;
    border-radius: 3px;
    overflow: hidden;
    vertical-align: middle;
    margin: 0 0.35rem;
  }

  .color-scale .good { flex: 1; background: rgba(40, 220, 80, 0.25); }
  .color-scale .mid { flex: 1; background: rgba(200, 200, 80, 0.15); }
  .color-scale .bad { flex: 1; background: rgba(220, 80, 80, 0.25); }

  .quality-header {
    background: #f0f7f0;
    border-bottom-color: #c3dfc3;
  }

  .quality-card { border-color: #c3dfc3; }

  /* QVAC-17830: per-device summary table used by --device-details.
     Row-per-test layout matching the markdown step-summary tables. */
  .detail-card .device-name { background: #eef3fa; border-bottom-color: #cfdcee; }
  .detail-sub {
    font-size: 0.78rem;
    font-weight: 400;
    color: var(--text-secondary);
    margin-left: 0.4rem;
  }
  .detail-table {
    table-layout: auto;
    font-size: 0.78rem;
  }
  .detail-table thead th {
    text-transform: none;
    letter-spacing: 0;
    font-size: 0.72rem;
  }
  .detail-table tbody td {
    white-space: nowrap;
    text-align: right;
  }
  .detail-table tbody td:first-child,
  .detail-table tbody td:nth-child(2),
  .detail-table tbody td:nth-child(3),
  .detail-table tbody td:nth-child(4) {
    text-align: left;
  }

  /* Scenario sub-heading inside a detail-card test-block. */
  .scenario-name {
    font-size: 0.85rem;
    font-weight: 600;
    color: var(--accent);
    margin: 0.25rem 0 0.4rem;
    text-transform: lowercase;
    letter-spacing: 0.02em;
  }

  .q-good {
    background: rgba(40, 167, 69, 0.12);
    color: #1a7f37;
    font-weight: 600;
  }

  .q-mid {
    background: rgba(210, 160, 40, 0.10);
    color: #7a6200;
  }

  .q-bad {
    background: rgba(220, 53, 69, 0.12);
    color: #cf222e;
    font-weight: 600;
  }

  .section-divider {
    margin: 2rem 0 1.5rem;
    padding-bottom: 0.5rem;
    border-bottom: 2px solid var(--border);
    font-size: 1.35rem;
    font-weight: 600;
    color: var(--text);
  }

  .detail-expand-row td {
    padding: 0 0.65rem 0.4rem;
    border-bottom: 1px solid #f0f0f0;
  }

  .quality-details {
    font-size: 0.78rem;
    color: var(--text-secondary);
  }

  .quality-details summary {
    cursor: pointer;
    color: var(--accent);
    font-weight: 500;
    padding: 0.2rem 0;
    user-select: none;
  }

  .quality-details summary:hover { text-decoration: underline; }

  .detail-body {
    padding: 0.5rem 0.75rem;
    margin-top: 0.3rem;
    background: #f8f9fb;
    border-radius: 4px;
    border: 1px solid var(--border);
  }

  .detail-row {
    margin-bottom: 0.35rem;
    line-height: 1.4;
    word-break: break-word;
  }

  .detail-row:last-child { margin-bottom: 0; }

  .detail-label {
    font-weight: 600;
    color: var(--text);
  }

  .detail-body code {
    font-family: 'SFMono-Regular', Consolas, 'Liberation Mono', Menlo, monospace;
    font-size: 0.72rem;
    background: #e8ecf0;
    padding: 0.1rem 0.3rem;
    border-radius: 3px;
    word-break: break-all;
  }

  .img-thumb {
    height: 28px;
    width: auto;
    border-radius: 3px;
    vertical-align: middle;
    margin-left: 6px;
    border: 1px solid var(--border);
    cursor: pointer;
    transition: box-shadow 0.15s;
  }

  .img-thumb:hover {
    box-shadow: 0 2px 8px rgba(0,0,0,0.3);
  }

  .img-lightbox {
    display: none;
    position: fixed;
    inset: 0;
    z-index: 1000;
    background: rgba(0,0,0,0.8);
    align-items: center;
    justify-content: center;
    cursor: zoom-out;
  }

  .img-lightbox.active {
    display: flex;
  }

  .img-lightbox img {
    max-width: 90vw;
    max-height: 90vh;
    border-radius: 6px;
    box-shadow: 0 8px 32px rgba(0,0,0,0.5);
  }

  .misread-table {
    width: 100%;
    margin-top: 0.4rem;
    border-collapse: collapse;
    font-size: 0.75rem;
  }

  .misread-table th,
  .misread-table td {
    padding: 0.25rem 0.5rem;
    border: 1px solid var(--border);
    text-align: left;
  }

  .misread-table th {
    background: #eef1f5;
    font-weight: 600;
    font-size: 0.7rem;
    text-transform: uppercase;
    letter-spacing: 0.02em;
  }

  .misread-table .found { color: #2e7d32; }
  .misread-table .not-found { color: #c62828; font-weight: 600; }

  .methodology {
    margin-top: 1.5rem;
  }

  .methodology h4 {
    font-size: 1rem;
    margin-bottom: 0.6rem;
  }

  .method-grid {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(280px, 1fr));
    gap: 0.75rem;
    margin-top: 0.75rem;
  }

  .method-card {
    padding: 0.75rem 1rem;
    background: #f8f9fb;
    border: 1px solid var(--border);
    border-radius: 6px;
  }

  .method-card h5 {
    font-size: 0.82rem;
    color: var(--text);
    margin-bottom: 0.3rem;
  }

  .method-card p {
    font-size: 0.78rem;
    line-height: 1.45;
    margin-bottom: 0.3rem;
  }

  .method-formula {
    font-family: 'SFMono-Regular', Consolas, 'Liberation Mono', Menlo, monospace;
    font-size: 0.72rem !important;
    background: #e8ecf0;
    padding: 0.25rem 0.5rem;
    border-radius: 4px;
    display: inline-block;
    margin-bottom: 0.4rem !important;
  }

  .method-note {
    font-style: italic;
    color: var(--text-secondary);
    font-size: 0.73rem !important;
  }

  @media print {
    body { padding: 0.5rem; }
    .device-card { break-inside: avoid; box-shadow: none; }
  }

  @media (max-width: 768px) {
    body { padding: 1rem; }
    table { font-size: 0.75rem; }
    .val { min-width: 70px; }
  }
</style>
</head>
<body>

<header class="report-header">
  <h1>${escapeHtml(addon)} Performance Report</h1>
  <div class="report-meta">
    <span>Generated: <strong>${escapeHtml(timestamp)}</strong></span>
    <span>CI Runs: <strong>${run_numbers.map(n => '#' + n).join(', ')}</strong></span>
    <span>Iterations per test: <strong>${iterationCount}</strong></span>
    <span>Devices: <strong>${Object.keys(devices).length}</strong></span>
  </div>
</header>

${detailSections ? `<h2 class="section-divider">Per-Device Summary</h2>` + detailSections : ''}

${deviceCards}

${qualitySection ? `<h2 class="section-divider">Accuracy &amp; Quality</h2>` + qualitySection : ''}

<div class="legend">
  <h4>Reading this report</h4>
  <p>
    Cell shading indicates relative performance within each metric:
    <span class="color-scale"><span class="good"></span><span class="mid"></span><span class="bad"></span></span>
    For time metrics, <strong>green = faster</strong> (better).
    For throughput metrics (TPS, tokens), <strong>green = higher</strong> (better).
    Mini bars at the bottom of each cell show magnitude relative to the max value.
  </p>
</div>

${qualitySection ? `
<div class="legend methodology">
  <h4>Quality Metrics — How We Measure</h4>

  <p>Each test image has a <strong>ground truth file</strong> (<code>.quality.json</code>) that contains the complete reference text,
  a list of expected keywords, and expected key-value pairs manually transcribed from the original document.
  Quality is evaluated by comparing the raw OCR output against this ground truth.</p>

  <div class="method-grid">
    <div class="method-card">
      <h5>CER — Character Error Rate</h5>
      <p class="method-formula">CER = edit_distance(hypothesis, reference) / length(reference)</p>
      <p>Measures character-level accuracy using <strong>Levenshtein edit distance</strong> — the minimum number of
      character insertions, deletions, and substitutions needed to transform the OCR output into the reference text.
      Both texts are normalized (lowercase, whitespace-collapsed) and <strong>tokens are sorted alphabetically</strong>
      before comparison to eliminate reading-order differences between platforms. <strong>Lower is better; 0% = perfect.</strong></p>
      <p class="method-note">Example: if OCR reads "Cretinine" instead of "Creatinine", that is 1 character error.</p>
    </div>

    <div class="method-card">
      <h5>WER — Word Error Rate</h5>
      <p class="method-formula">WER = edit_distance(hyp_words, ref_words) / count(ref_words)</p>
      <p>Same as CER but at the <strong>word level</strong> — counts how many words need to be inserted, deleted,
      or substituted. Tokens are also sorted alphabetically before comparison.
      <strong>Lower is better; 0% = perfect.</strong> Values above 100% are possible when the OCR generates more words than the reference.</p>
    </div>

    <div class="method-card">
      <h5>Word Recognition — Single-Word Detection</h5>
      <p class="method-formula">Rate = unique_words_found / unique_words_in_reference</p>
      <p>Tokenizes the reference text into <strong>unique individual words</strong>, then checks whether each word
      appears anywhere in the OCR output (case-insensitive substring match). This is the same approach used by
      the <strong>Android on-device benchmark</strong> (Dima's benchmark script).
      <strong>Higher is better; 100% = every word found.</strong></p>
      <p class="method-note">This metric is inherently order-independent and lenient — it only asks "did the OCR see this word at all?"
      It does not check spelling accuracy, word order, or whether key-value pairs are correctly associated.
      It will show high scores (&gt;95%) even when the full text has significant errors, because most individual
      common words are correctly recognized.</p>
    </div>

    <div class="method-card">
      <h5>Keyword Detection Rate</h5>
      <p class="method-formula">Rate = keywords_found / keywords_expected</p>
      <p>Checks whether specific <strong>expected terms</strong> (medical terms, patient identifiers, section headers)
      appear anywhere in the OCR output. Multi-word keywords (e.g., "ALLIED CARE EXPERTS") use <strong>word-level matching</strong>
      — every word in the phrase must exist somewhere in the output, regardless of order.
      <strong>Higher is better; 100% = all keywords found.</strong></p>
      <p class="method-note">Unlike Word Recognition, this uses a curated list of domain-specific terms. Failures mean the OCR genuinely
      could not recognize the term — e.g., reading "ALTISGPT" instead of "ALT/SGPT".</p>
    </div>

    <div class="method-card">
      <h5>KV Accuracy — Key-Value Extraction</h5>
      <p class="method-formula">Accuracy = pairs_matched / pairs_expected</p>
      <p>For structured documents (lab reports, forms), checks whether both the <strong>key</strong> (e.g., "SGOT")
      and its <strong>value</strong> (e.g., "162") appear in the OCR output. Keys use word-level matching;
      values use exact substring matching. <strong>Higher is better; 100% = all pairs extracted.</strong></p>
      <p class="method-note">A pair fails if the key is misread OR the value is misread. The diagnostic details show which one failed.</p>
    </div>
  </div>

  <p style="margin-top:0.8rem"><strong>Two approaches to accuracy:</strong> The <em>Word Recognition</em> rate answers "can the OCR see
  individual words?" — it is lenient and typically shows high scores (&gt;95%). The <em>CER/WER</em> metrics answer "how accurately can
  you reconstruct the full document text?" — they are stricter and reflect real-world extraction quality. Both are valuable:
  Word Recognition confirms the engine works; CER/WER reveals how much post-processing or error correction may be needed.</p>

  <p style="margin-top:0.4rem"><strong>Note on token sorting:</strong> OCR engines return text regions as individual bounding boxes in spatial
  detection order, not natural reading order. The same document may be read top-to-bottom on one platform and bottom-to-top on another.
  Sorting tokens alphabetically before computing CER/WER makes the metrics <strong>reading-order independent</strong>,
  ensuring consistent, comparable results across desktop, Android, and iOS.</p>
</div>
` : ''}


<div class="img-lightbox" id="imgLightbox" onclick="closeLightbox()">
  <img id="lightboxImg" src="" alt="full size">
</div>

<script>
function openLightbox(src) {
  var lb = document.getElementById('imgLightbox');
  document.getElementById('lightboxImg').src = src;
  lb.classList.add('active');
}
function closeLightbox() {
  document.getElementById('imgLightbox').classList.remove('active');
}
document.addEventListener('keydown', function(e) {
  if (e.key === 'Escape') closeLightbox();
});
</script>

<script type="application/json" id="report-data">
${escapeHtml(dataJson)}
</script>
</body>
</html>
`
}

module.exports = {
  mean,
  stddev,
  summarize,
  round2,
  metricLabel,
  formatMetricValue,
  generateMarkdownReport,
  generateDeviceDetailTables,
  generateHtmlReport,
  aggregateReports
}
