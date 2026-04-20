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

function formatQualityValue (key, value) {
  if (value === null || value === undefined) return '-'
  if (['cer', 'wer', 'word_recognition_rate', 'keyword_detection_rate', 'key_value_accuracy'].includes(key)) {
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

function generateMarkdownReport (aggregated) {
  const lines = []
  const { addon, generated_at, run_numbers, devices, quality } = aggregated
  const iterCount = _maxIterationCount(devices)

  lines.push(`## ${addon} Performance Report`)
  lines.push(`Generated: ${generated_at} | CI Runs: ${run_numbers.join(', ')} | Iterations: ${iterCount}`)
  lines.push('')

  const deviceNames = Object.keys(devices)
  if (!deviceNames.length) return lines.join('\n') + '\n'

  const shortNames = deviceNames.map(_shortDeviceName)

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

  // --- Performance Summary (combined) ---
  lines.push('### Performance Summary (Mean Total Time)')
  lines.push('')

  const perfHeader = hasEp ? ['Test', 'EP'] : ['Test']
  for (const sn of shortNames) perfHeader.push(sn)
  lines.push('| ' + perfHeader.join(' | ') + ' |')
  lines.push('| ' + perfHeader.map(() => '---').join(' | ') + ' |')

  for (const t of parsed) {
    const cells = hasEp ? [t.base, `**${t.ep}**`] : [t.full]
    for (const devName of deviceNames) {
      const metrics = devices[devName] && devices[devName][t.full]
      if (metrics && metrics.total_time_ms) {
        const s = metrics.total_time_ms
        cells.push(`${Math.round(s.mean)} \u00b1${Math.round(s.std)}ms`)
      } else {
        cells.push('-')
      }
    }
    lines.push('| ' + cells.join(' | ') + ' |')
  }
  lines.push('')

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

      const qKeys = ['cer', 'wer', 'keyword_detection_rate', 'key_value_accuracy']
      const qShort = { cer: 'CER', wer: 'WER', keyword_detection_rate: 'KW', key_value_accuracy: 'KV' }

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
  const imagePathMap = {}

  for (const report of reports) {
    const deviceName = report.device ? report.device.name : 'unknown'

    if (!deviceMap[deviceName]) deviceMap[deviceName] = {}
    if (!qualityMap[deviceName]) qualityMap[deviceName] = {}

    for (const result of (report.results || [])) {
      const testKey = result.test
      if (!deviceMap[deviceName][testKey]) deviceMap[deviceName][testKey] = {}

      if (result.image_path && !imagePathMap[testKey]) {
        imagePathMap[testKey] = result.image_path
      }

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
    image_paths: imagePathMap,
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
 * Generates a self-contained HTML performance report.
 *
 * @param {Object} aggregated - Output of aggregateReports()
 * @returns {string} Complete HTML document
 */
function generateHtmlReport (aggregated) {
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
  generateHtmlReport,
  aggregateReports
}
