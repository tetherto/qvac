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
  decode_time_ms: 'Decode time',
  ttft_ms: 'TTFT',
  generated_tokens: 'Generated tokens',
  prompt_tokens: 'Prompt tokens',
  tps: 'TPS',
  text_regions: 'Text regions',
  real_time_factor: 'RTF',
  sample_count: 'Samples',
  duration_ms: 'Duration'
}

function metricLabel (key) {
  return METRIC_LABELS[key] || key
}

function formatMetricValue (key, value) {
  if (value === null || value === undefined) return '-'
  if (key.endsWith('_ms')) return `${Math.round(value)}ms`
  if (key === 'tps') return `${value.toFixed(2)} t/s`
  if (key === 'real_time_factor') return value.toFixed(2)
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
const QUALITY_LABELS = {
  cer: 'CER',
  wer: 'WER',
  keyword_detection_rate: 'Keyword Detection',
  key_value_accuracy: 'KV Accuracy',
  keywords_found: 'Keywords Found',
  keywords_total: 'Keywords Total',
  key_values_matched: 'KV Matched',
  key_values_total: 'KV Total'
}

function formatQualityValue (key, value) {
  if (value === null || value === undefined) return '-'
  if (['cer', 'wer', 'keyword_detection_rate', 'key_value_accuracy'].includes(key)) {
    return (value * 100).toFixed(1) + '%'
  }
  if (Number.isInteger(value)) return String(value)
  return value.toFixed(2)
}

function generateMarkdownReport (aggregated) {
  const lines = []
  const { addon, generated_at, run_numbers, devices, quality } = aggregated

  const iterCount = _maxIterationCount(devices)

  lines.push(`## ${addon} Performance Report`)
  lines.push(`Generated: ${generated_at} | CI Runs: ${run_numbers.join(', ')} | Iterations: ${iterCount}`)
  lines.push('')

  for (const [deviceName, tests] of Object.entries(devices)) {
    lines.push(`### ${deviceName}`)
    lines.push('')

    const iterCols = _mdIterationHeaders(iterCount, run_numbers)
    const header = ['Metric', ...iterCols, 'Mean', 'Std Dev']
    lines.push('| ' + header.join(' | ') + ' |')
    lines.push('| ' + header.map(() => '---').join(' | ') + ' |')

    for (const [testName, metrics] of Object.entries(tests)) {
      lines.push(`| **${testName}** | ${' |'.repeat(iterCount + 2)}`)
      for (const [metricKey, summary] of Object.entries(metrics)) {
        if (!summary) continue
        const vals = []
        for (let i = 0; i < iterCount; i++) {
          const v = summary.values[i]
          vals.push(v !== undefined ? formatMetricValue(metricKey, v) : '-')
        }
        const meanStr = formatMetricValue(metricKey, summary.mean)
        const stdStr = '\u00b1' + formatMetricValue(metricKey, summary.std)
        lines.push(`| ${metricLabel(metricKey)} | ${vals.join(' | ')} | ${meanStr} | ${stdStr} |`)
      }
    }
    lines.push('')
  }

  if (quality && Object.keys(quality).length > 0) {
    lines.push('---')
    lines.push('')
    lines.push(`## ${addon} Quality Report`)
    lines.push('')

    for (const [deviceName, tests] of Object.entries(quality)) {
      const hasData = Object.values(tests).some(m => Object.keys(m).length > 0)
      if (!hasData) continue

      lines.push(`### ${deviceName}`)
      lines.push('')

      const qHeader = ['Test', 'CER', 'WER', 'Keyword Rate', 'KV Accuracy']
      lines.push('| ' + qHeader.join(' | ') + ' |')
      lines.push('| ' + qHeader.map(() => '---').join(' | ') + ' |')

      for (const [testName, metrics] of Object.entries(tests)) {
        if (!Object.keys(metrics).length) continue
        const cerVal = metrics.cer ? formatQualityValue('cer', metrics.cer.mean) : '-'
        const werVal = metrics.wer ? formatQualityValue('wer', metrics.wer.mean) : '-'
        const kwRate = metrics.keyword_detection_rate ? formatQualityValue('keyword_detection_rate', metrics.keyword_detection_rate.mean) : '-'
        const kvAcc = metrics.key_value_accuracy ? formatQualityValue('key_value_accuracy', metrics.key_value_accuracy.mean) : '-'
        lines.push(`| ${testName} | ${cerVal} | ${werVal} | ${kwRate} | ${kvAcc} |`)
      }
      lines.push('')
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
  if (!reports.length) return { addon: 'unknown', devices: {}, run_numbers: [], quality: {} }

  const addon = reports[0].addon
  const runNumbers = [...new Set(reports.map(r => r.run_number).filter(Boolean))]

  const deviceMap = {}
  const qualityMap = {}

  for (const report of reports) {
    const deviceName = report.device ? report.device.name : 'unknown'

    if (!deviceMap[deviceName]) deviceMap[deviceName] = {}
    if (!qualityMap[deviceName]) qualityMap[deviceName] = {}

    for (const result of (report.results || [])) {
      const testKey = result.test
      if (!deviceMap[deviceName][testKey]) deviceMap[deviceName][testKey] = {}

      for (const [metricKey, value] of Object.entries(result.metrics || {})) {
        if (value === null || value === undefined) continue
        if (!deviceMap[deviceName][testKey][metricKey]) {
          deviceMap[deviceName][testKey][metricKey] = []
        }
        deviceMap[deviceName][testKey][metricKey].push(value)
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
    quality_details: qualityDetails
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
 * Generates a self-contained HTML performance report.
 *
 * @param {Object} aggregated - Output of aggregateReports()
 * @returns {string} Complete HTML document
 */
function generateHtmlReport (aggregated) {
  const { addon, generated_at, run_numbers, devices, quality } = aggregated
  const timestamp = new Date(generated_at).toLocaleString('en-US', {
    dateStyle: 'medium',
    timeStyle: 'short'
  })

  const iterationCount = _maxIterationCount(devices)

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

  let qualitySection = ''
  const qualityDetails = aggregated.quality_details || {}

  if (quality && Object.keys(quality).length > 0) {
    const qualityKeys = ['cer', 'wer', 'keyword_detection_rate', 'key_value_accuracy']
    const qLabels = { cer: 'CER', wer: 'WER', keyword_detection_rate: 'Keyword Detection', key_value_accuracy: 'KV Accuracy' }
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

        qRows += `<tr><td class="metric-name">${escapeHtml(testName)}</td>${cells}</tr>`

        const detail = devDetails[testName]
        if (detail) {
          let detailContent = ''
          if (detail.hypothesis_preview) {
            detailContent += `<div class="detail-row"><span class="detail-label">OCR output (sorted tokens):</span> <code>${escapeHtml(detail.hypothesis_preview)}</code></div>`
          }
          if (detail.keywords_missing && detail.keywords_missing.length > 0) {
            detailContent += `<div class="detail-row"><span class="detail-label">Missing keywords (${detail.keywords_missing.length}):</span> ${escapeHtml(detail.keywords_missing.join(', '))}</div>`
          }
          if (detail.kv_unmatched && detail.kv_unmatched.length > 0) {
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
  <p style="margin-top:0.4rem">
    <strong>Quality metrics:</strong>
    CER = Character Error Rate (lower is better),
    WER = Word Error Rate (lower is better),
    Keyword Detection = fraction of expected keywords found (higher is better),
    KV Accuracy = key-value pair extraction accuracy (higher is better).
  </p>
</div>

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
  generateHtmlReport,
  aggregateReports
}
