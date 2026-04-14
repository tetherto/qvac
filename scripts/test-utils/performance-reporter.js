'use strict'

/**
 * Shared performance reporter for QVAC addon integration tests.
 *
 * Collects structured metrics during test runs and writes:
 *   - JSON artifact  (for CI upload / aggregation)
 *   - GitHub Step Summary  (markdown table visible in Actions UI)
 *
 * Compatible with both Node.js and Bare runtime.
 */

// ---------------------------------------------------------------------------
// Runtime modules — set via configure() for Bare, auto-detected for Node.js
// ---------------------------------------------------------------------------

let fs, pathMod, processMod, osMod
let _configured = false

function _ensureNodeDefaults () {
  if (_configured) return
  fs = require('fs')
  pathMod = require('path')
  processMod = process
  osMod = require('os')
}

/**
 * Inject runtime modules for Bare compatibility.
 * Must be called before createPerformanceReporter() when running under Bare,
 * because Bare cannot resolve bare-fs/bare-path from this file's location.
 *
 * @param {Object} mods
 * @param {Object} mods.fs       - bare-fs or Node fs
 * @param {Object} mods.path     - bare-path or Node path
 * @param {Object} mods.process  - bare-process or Node process
 * @param {Object} mods.os       - bare-os or Node os
 */
function configure (mods) {
  fs = mods.fs
  pathMod = mods.path
  processMod = mods.process
  osMod = mods.os
  _configured = true
}

// ---------------------------------------------------------------------------
// Device / CI detection
// ---------------------------------------------------------------------------

function getEnvVar (name) {
  if (typeof osMod.getEnv === 'function') {
    try { return osMod.getEnv(name) || '' } catch (_) { return '' }
  }
  return (processMod.env && processMod.env[name]) || ''
}

function detectDevice () {
  const platform = osMod.platform ? osMod.platform() : processMod.platform
  const arch = osMod.arch ? osMod.arch() : processMod.arch

  const dfName = getEnvVar('DEVICE_FARM_DEVICE_NAME') ||
                 getEnvVar('DEVICEFARM_DEVICE_NAME')

  if (dfName) {
    return {
      name: dfName,
      platform,
      os_version: getEnvVar('DEVICE_FARM_DEVICE_OS_VERSION') || '',
      arch,
      runner: 'device-farm'
    }
  }

  const runnerName = getEnvVar('RUNNER_NAME')
  const runnerOs = getEnvVar('RUNNER_OS')
  const prettyName = runnerName || `${platform}-${arch}`

  return {
    name: prettyName,
    platform,
    os_version: runnerOs || '',
    arch,
    runner: getEnvVar('GITHUB_ACTIONS') ? 'github-actions' : 'local'
  }
}

function detectCIMetadata () {
  return {
    run_id: getEnvVar('GITHUB_RUN_ID') || null,
    run_number: parseInt(getEnvVar('GITHUB_RUN_NUMBER'), 10) || null,
    workflow: getEnvVar('GITHUB_WORKFLOW') || null,
    ref: getEnvVar('GITHUB_REF') || null,
    sha: getEnvVar('GITHUB_SHA') || null
  }
}

// ---------------------------------------------------------------------------
// Metric column definitions per addon type
// ---------------------------------------------------------------------------

const QUALITY_COLUMNS = {
  ocr: [
    { key: 'cer', label: 'CER' },
    { key: 'wer', label: 'WER' },
    { key: 'keyword_detection_rate', label: 'Keyword Rate' },
    { key: 'key_value_accuracy', label: 'KV Accuracy' }
  ]
}

const METRIC_COLUMNS = {
  ocr: [
    { key: 'total_time_ms', label: 'Total Time (ms)' },
    { key: 'detection_time_ms', label: 'Detection (ms)' },
    { key: 'recognition_time_ms', label: 'Recognition (ms)' },
    { key: 'text_regions', label: 'Text Regions' }
  ],
  translation: [
    { key: 'total_time_ms', label: 'Total Time (ms)' },
    { key: 'decode_time_ms', label: 'Decode (ms)' },
    { key: 'generated_tokens', label: 'Tokens' },
    { key: 'tps', label: 'TPS' }
  ],
  vision: [
    { key: 'total_time_ms', label: 'Total Time (ms)' },
    { key: 'ttft_ms', label: 'TTFT (ms)' },
    { key: 'generated_tokens', label: 'Gen Tokens' },
    { key: 'prompt_tokens', label: 'Prompt Tokens' },
    { key: 'tps', label: 'TPS' }
  ],
  tts: [
    { key: 'total_time_ms', label: 'Total Time (ms)' },
    { key: 'tps', label: 'Tokens/sec' },
    { key: 'real_time_factor', label: 'RTF' },
    { key: 'sample_count', label: 'Samples' }
  ],
  generic: [
    { key: 'total_time_ms', label: 'Total Time (ms)' },
    { key: 'tps', label: 'TPS' }
  ]
}

// ---------------------------------------------------------------------------
// Reporter factory
// ---------------------------------------------------------------------------

/**
 * @param {Object} opts
 * @param {string} opts.addon       - Addon identifier (e.g. 'ocr-onnx', 'nmtcpp')
 * @param {string} [opts.addonType] - One of 'ocr','translation','vision','tts','generic'
 * @param {Object} [opts.device]    - Override auto-detected device info
 */
function createPerformanceReporter (opts) {
  _ensureNodeDefaults()
  const addon = opts.addon
  const addonType = opts.addonType || 'generic'
  const device = opts.device || detectDevice()
  const ci = detectCIMetadata()
  const results = []
  const startedAt = new Date().toISOString()

  return {
    /**
     * Record a single test result.
     *
     * @param {string} testName         - Human-readable test name (e.g. '[GPU] OCR Basic')
     * @param {Object} metrics          - Metric key/value pairs (use null for N/A)
     * @param {Object} [extra]          - Optional extra fields (input, output, execution_provider)
     */
    record (testName, metrics, extra) {
      const entry = {
        test: testName,
        execution_provider: (extra && extra.execution_provider) || null,
        metrics: {
          total_time_ms: null,
          detection_time_ms: null,
          recognition_time_ms: null,
          decode_time_ms: null,
          ttft_ms: null,
          generated_tokens: null,
          prompt_tokens: null,
          tps: null,
          text_regions: null,
          real_time_factor: null,
          sample_count: null,
          duration_ms: null,
          ...metrics
        },
        input: (extra && extra.input) || null,
        output: (extra && extra.output) || null
      }

      if (extra && extra.quality) {
        entry.quality = extra.quality
      }

      if (extra && extra.image_path) {
        entry.image_path = extra.image_path
      }

      results.push(entry)
    },

    /** Build the full JSON report object. */
    toJSON () {
      return {
        schema_version: '1.0',
        addon,
        addon_type: addonType,
        timestamp: startedAt,
        run_id: ci.run_id,
        run_number: ci.run_number,
        workflow: ci.workflow,
        ref: ci.ref,
        sha: ci.sha,
        device,
        results
      }
    },

    /**
     * Persist the report as JSON.
     * Creates parent directories if needed.
     *
     * @param {string} destPath - File path (relative or absolute)
     */
    writeReport (destPath) {
      try {
        const dir = pathMod.dirname(destPath)
        fs.mkdirSync(dir, { recursive: true })
        const json = JSON.stringify(this.toJSON(), null, 2) + '\n'
        fs.writeFileSync(destPath, json)
        console.log(`[perf-reporter] wrote ${destPath} (${results.length} results)`)
      } catch (err) {
        console.log(`[perf-reporter] failed to write report: ${err.message}`)
      }
    },

    /**
     * Append a markdown summary table to $GITHUB_STEP_SUMMARY.
     * No-op outside GitHub Actions.
     */
    writeStepSummary () {
      const summaryPath = getEnvVar('GITHUB_STEP_SUMMARY')
      if (!summaryPath) {
        console.log('[perf-reporter] not in GitHub Actions, skipping step summary')
        return
      }

      const cols = METRIC_COLUMNS[addonType] || METRIC_COLUMNS.generic
      const qCols = QUALITY_COLUMNS[addonType] || []
      const lines = []

      lines.push(`### Performance: ${addon}`)
      lines.push('')
      lines.push(`> Device: **${device.name}** (${device.platform}/${device.arch}) | ` +
                  `Run: ${ci.run_number || 'local'} | ${startedAt}`)
      lines.push('')

      const header = ['Test', 'EP', ...cols.map(c => c.label)]
      lines.push('| ' + header.join(' | ') + ' |')
      lines.push('| ' + header.map(() => '---').join(' | ') + ' |')

      for (const r of results) {
        const ep = r.execution_provider || '-'
        const vals = cols.map(c => {
          const v = r.metrics[c.key]
          if (v === null || v === undefined) return '-'
          if (typeof v === 'number') return Number.isInteger(v) ? String(v) : v.toFixed(2)
          return String(v)
        })
        lines.push('| ' + [r.test, ep, ...vals].join(' | ') + ' |')
      }

      lines.push('')

      const qualityResults = results.filter(r => r.quality)
      if (qualityResults.length > 0 && qCols.length > 0) {
        lines.push(`### Quality: ${addon}`)
        lines.push('')

        const qHeader = ['Test', ...qCols.map(c => c.label)]
        lines.push('| ' + qHeader.join(' | ') + ' |')
        lines.push('| ' + qHeader.map(() => '---').join(' | ') + ' |')

        for (const r of qualityResults) {
          const vals = qCols.map(c => {
            const v = r.quality[c.key]
            if (v === null || v === undefined) return '-'
            if (typeof v === 'number') return (v * 100).toFixed(1) + '%'
            return String(v)
          })
          lines.push('| ' + [r.test, ...vals].join(' | ') + ' |')
        }

        lines.push('')
      }

      try {
        fs.appendFileSync(summaryPath, lines.join('\n') + '\n')
        console.log(`[perf-reporter] wrote GitHub Step Summary (${results.length} rows)`)
      } catch (err) {
        console.log(`[perf-reporter] failed to write step summary: ${err.message}`)
      }
    },

    /**
     * Write the full JSON report to stdout using delimiters so it can be
     * extracted from Device Farm console logs.  Harmless on desktop — just
     * extra console output.
     */
    writeToConsole () {
      try {
        const json = JSON.stringify(this.toJSON())
        console.log('[PERF_REPORT_START]' + json + '[PERF_REPORT_END]')
      } catch (err) {
        console.log(`[perf-reporter] failed to write console report: ${err.message}`)
      }
    },

    /** Number of results recorded so far. */
    get length () { return results.length }
  }
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = {
  configure,
  createPerformanceReporter,
  detectDevice,
  detectCIMetadata,
  METRIC_COLUMNS,
  QUALITY_COLUMNS
}

