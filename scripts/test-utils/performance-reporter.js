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

let fs, pathMod, processMod, osMod, subprocessMod
let _configured = false

function _ensureNodeDefaults () {
  if (_configured) return
  fs = require('fs')
  pathMod = require('path')
  processMod = process
  osMod = require('os')
  // Node's child_process is always available; Bare callers inject
  // bare-subprocess via configure() because this file's location
  // can't resolve bare-subprocess from its own node_modules walk.
  try { subprocessMod = require('child_process') } catch (_) {}
}

/**
 * Inject runtime modules for Bare compatibility.
 * Must be called before createPerformanceReporter() when running under Bare,
 * because Bare cannot resolve bare-fs/bare-path from this file's location.
 *
 * @param {Object} mods
 * @param {Object} mods.fs         - bare-fs or Node fs
 * @param {Object} mods.path       - bare-path or Node path
 * @param {Object} mods.process    - bare-process or Node process
 * @param {Object} mods.os         - bare-os or Node os
 * @param {Object} [mods.subprocess] - bare-subprocess (Bare) or
 *                                     child_process (Node). Optional;
 *                                     enables GPU probe under Bare since
 *                                     this file's directory has no
 *                                     bare-subprocess in node_modules.
 */
function configure (mods) {
  fs = mods.fs
  pathMod = mods.path
  processMod = mods.process
  osMod = mods.os
  if (mods.subprocess) {
    subprocessMod = mods.subprocess
  } else if (!subprocessMod) {
    // No explicit subprocess injection — try child_process for Node
    // callers (Bare callers always set mods.subprocess to bare-subprocess
    // since require('child_process') throws there).
    try { subprocessMod = require('child_process') } catch (_) {}
  }
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

// QVAC-17830: lightweight GPU probe so reports can label the actual
// GPU (NVIDIA Tesla T4 vs Apple M2 Max vs integrated Intel) instead
// of the opaque "linux-x64-u24-gpu" / "darwin-arm64" runner names. Falls
// back to null on any failure — runs once per `createPerformanceReporter`
// so the subprocess cost is paid at most once per test suite.
//
// Subprocess driver:
//   * Node — auto-loads `child_process.execSync` via _ensureNodeDefaults().
//   * Bare — caller must pass `subprocess: require('bare-subprocess')`
//     to configure(); this file's directory can't resolve bare-subprocess
//     from its own node_modules walk, so the require has to happen in
//     the caller's scope (see packages/llm-llamacpp/test/integration/
//     _perf-helper.js for the canonical wiring).
function _detectGpu (platform) {
  // The subprocess driver is resolved at configure() time so the
  // require lookup happens in the CALLER's directory (where
  // bare-subprocess actually lives) rather than this file's
  // directory (which has no node_modules). Falls back to null when
  // neither runtime module is loadable. Both Node's child_process
  // and bare-subprocess expose a synchronous variant we adapt below.
  if (!subprocessMod) return null
  const nodeExecSync = subprocessMod.execSync || null
  const bareSpawnSync = !nodeExecSync && subprocessMod.spawnSync
    ? subprocessMod.spawnSync
    : null
  if (!nodeExecSync && !bareSpawnSync) return null

  function _safeExec (cmd) {
    if (nodeExecSync) {
      try {
        return nodeExecSync(cmd, {
          encoding: 'utf-8',
          stdio: ['pipe', 'pipe', 'pipe'],
          timeout: 5000
        }).trim()
      } catch (_) {
        return null
      }
    }
    // Bare path: spawnSync takes (bin, args[]). All commands we shell
    // out to here are flat (no shell metacharacters, no quoting) so a
    // simple split-on-whitespace is safe.
    try {
      const parts = cmd.split(/\s+/).filter(Boolean)
      if (!parts.length) return null
      const res = bareSpawnSync(parts[0], parts.slice(1), {
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: 5000
      })
      if (!res || res.status !== 0) return null
      const out = res.stdout
      const str = out && typeof out.toString === 'function'
        ? out.toString('utf-8')
        : String(out || '')
      return str.trim()
    } catch (_) {
      return null
    }
  }

  function _parseNvidiaSmi (out) {
    if (!out) return null
    const m = out.match(/GPU \d+:\s*(.+?)(?:\s*\(UUID:|$)/m)
    return m ? m[1].trim() : null
  }

  // Follow-up to QVAC-17830 (Olya, 17 May): the original Linux probe
  // only tried `nvidia-smi -L` then `lspci`, which both return null on
  // minimal self-hosted runner containers (e.g. qvac-ubuntu2404-x64-gpu-runner)
  // even when the GPU itself is healthy and Vulkan inference is running
  // against it. `vulkaninfo --summary` is present wherever the Vulkan
  // ICD is installed (which is exactly when the [GPU] rows have data
  // to show), so it's a high-signal fallback for that case. Returns
  // null when vulkaninfo is missing or reports zero devices.
  function _parseVulkaninfoSummary (out) {
    if (!out) return null
    const m = out.match(/deviceName\s*=\s*(.+)$/m)
    return m ? m[1].trim() : null
  }

  // Sysfs PCI vendor fallback for Linux. Always present on physical
  // hardware (and most cloud VMs) without needing nvidia-smi / lspci /
  // vulkaninfo installed. Returns "<vendor> GPU (PCI <vendor:device>)"
  // when we can read it. Coarser than the named probes above but
  // beats `null` for runners that ship without any of the userspace
  // GPU tools.
  function _readLinuxSysfsGpu () {
    // Prefer the runtime-configured fs/path modules so this works under
    // Bare (bare-fs / bare-path) without needing a separate require.
    // Falls back to Node's built-ins for callers that haven't run
    // configure() yet.
    let fsM = fs
    let pathM = pathMod
    if (!fsM || !pathM) {
      try {
        fsM = fsM || require('fs')
        pathM = pathM || require('path')
      } catch (_) {
        return null
      }
    }
    const drm = '/sys/class/drm'
    let entries
    try {
      entries = fsM.readdirSync(drm).filter(n => /^card\d+$/.test(n))
    } catch (_) {
      return null
    }
    const vendorMap = {
      '0x10de': 'NVIDIA',
      '0x8086': 'Intel',
      '0x1002': 'AMD',
      '0x1af4': 'VirtIO',
      '0x1234': 'QEMU'
    }
    for (const card of entries) {
      try {
        const vendor = fsM.readFileSync(pathM.join(drm, card, 'device', 'vendor'), 'utf8').trim()
        const device = fsM.readFileSync(pathM.join(drm, card, 'device', 'device'), 'utf8').trim()
        const label = vendorMap[vendor] || `PCI ${vendor}`
        return `${label} GPU (PCI ${vendor}:${device})`
      } catch (_) {
        continue
      }
    }
    return null
  }

  if (platform === 'linux') {
    const nv = _parseNvidiaSmi(_safeExec('nvidia-smi -L'))
    if (nv) return nv
    const lspci = _safeExec('lspci')
    if (lspci) {
      const lines = lspci.split('\n').filter(l => /VGA|3D|Display/i.test(l))
      if (lines.length) {
        const m = lines[0].match(/(?:VGA|3D|Display)[^:]*:\s*(.+)$/)
        if (m) return m[1].trim()
      }
    }
    const vk = _parseVulkaninfoSummary(_safeExec('vulkaninfo --summary'))
    if (vk) return vk
    const sysfs = _readLinuxSysfsGpu()
    if (sysfs) return sysfs
    return null
  }

  if (platform === 'win32') {
    const nv = _parseNvidiaSmi(_safeExec('nvidia-smi -L'))
    if (nv) return nv
    const wmic = _safeExec('wmic path win32_VideoController get name')
    if (wmic) {
      const lines = wmic.split('\n').slice(1).map(l => l.trim()).filter(Boolean)
      if (lines.length) return lines[0]
    }
    const vk = _parseVulkaninfoSummary(_safeExec('vulkaninfo --summary'))
    if (vk) return vk
    return null
  }

  if (platform === 'darwin') {
    const sp = _safeExec('system_profiler SPDisplaysDataType')
    if (sp) {
      const m = sp.match(/Chipset Model:\s*(.+)$/m)
      if (m) return m[1].trim()
    }
    // Follow-up to QVAC-17830 (Olya, 17 May): GitHub-hosted macOS
    // runners are virtualised Macs (macos-15-arm64 = M2 Pro VM with
    // an `apple paravirtual device` GPU). SPDisplaysDataType returns
    // no `Chipset Model:` line on those VMs because the paravirtual
    // device isn't a real display, so we fall back to the host chip
    // identity. On Apple Silicon, the chip name implies the GPU
    // (M2 Pro -> integrated 19-core GPU, M4 Pro -> integrated 20-core,
    // etc.) which is what reviewers want to know anyway. SPHardware
    // first (returns "Chip: Apple M2 Pro" on Apple Silicon or
    // "Processor Name: ..." on Intel); sysctl second as a fast pure
    // fallback.
    const hw = _safeExec('system_profiler SPHardwareDataType')
    if (hw) {
      const chip = hw.match(/^\s*Chip:\s*(.+)$/m)
      if (chip) return chip[1].trim()
      const proc = hw.match(/^\s*Processor Name:\s*(.+)$/m)
      if (proc) return proc[1].trim()
    }
    const cpu = _safeExec('sysctl -n machdep.cpu.brand_string')
    if (cpu) return cpu
    const vk = _parseVulkaninfoSummary(_safeExec('vulkaninfo --summary'))
    if (vk) return vk
    return null
  }

  // android / ios: probing is harder from inside Bare. Leave null
  // and let the aggregator surface device.name (Device Farm label
  // already encodes the model — "iPhone 17 Pro", "Samsung Galaxy
  // S24" — which implies the chipset).
  return null
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
      gpu: null,
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
    gpu: _detectGpu(platform),
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
  ],
  vla: [
    { key: 'action_max_abs_diff', label: 'Max \\|Δ\\|', unit: 'raw' },
    { key: 'action_mean_abs_diff', label: 'Mean \\|Δ\\|', unit: 'raw' },
    { key: 'action_cos_sim', label: 'Cosine Sim', unit: 'cos-sim' }
  ],
  // pi05 reports the same end-to-end action quality as smolvla — just a
  // separate addon_type so the metric table can carry pi05-specific
  // per-component timings (prefill_compute_ms etc.).
  pi05: [
    { key: 'action_max_abs_diff', label: 'Max \\|Δ\\|', unit: 'raw' },
    { key: 'action_mean_abs_diff', label: 'Mean \\|Δ\\|', unit: 'raw' },
    { key: 'action_cos_sim', label: 'Cosine Sim', unit: 'cos-sim' }
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
    { key: 'tps', label: 'TPS' },
    { key: 'chrfpp', label: 'chrF++', format: 'percent' }
  ],
  vision: [
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
  ],
  tts: [
    { key: 'total_time_ms', label: 'Total Time (ms)' },
    { key: 'tps', label: 'Tokens/sec' },
    { key: 'real_time_factor', label: 'RTF' },
    { key: 'sample_count', label: 'Samples' }
  ],
  vla: [
    { key: 'total_time_ms', label: 'Total Time (ms)' },
    { key: 'vision_time_ms', label: 'Vision (ms)' },
    { key: 'smollm2_compute_time_ms', label: 'SmolLM2 Compute (ms)' },
    { key: 'smollm2_total_time_ms', label: 'SmolLM2 Total (ms)' },
    { key: 'ode_time_ms', label: 'ODE (ms)' }
  ],
  // π₀.₅ — same five-section breakdown the test records: vision encoder,
  // PaliGemma VLM prefill (compute vs total — total includes graph build
  // amortisation), 10-step ODE loop, and total. Keys match what
  // pi05.test.js writes via `_perfReporter.record`.
  pi05: [
    { key: 'total_time_ms', label: 'Total Time (ms)' },
    { key: 'vision_time_ms', label: 'Vision (ms)' },
    { key: 'prefill_compute_time_ms', label: 'Prefill Compute (ms)' },
    { key: 'prefill_total_time_ms', label: 'Prefill Total (ms)' },
    { key: 'ode_time_ms', label: 'ODE (ms)' }
  ],
  parakeet: [
    { key: 'real_time_factor', label: 'RTF' },
    { key: 'wall_time_ms', label: 'Wall (ms)' },
    { key: 'tps', label: 'Tokens/sec' },
    { key: 'encoder_time_ms', label: 'Encoder (ms)' },
    { key: 'decoder_time_ms', label: 'Decoder (ms)' },
    { key: 'audio_duration_ms', label: 'Audio (ms)' }
  ],
  whisper: [
    { key: 'real_time_factor', label: 'RTF' },
    { key: 'wall_time_ms', label: 'Wall (ms)' },
    { key: 'tps', label: 'Tokens/sec' },
    { key: 'whisper_encode_time_ms', label: 'Encode (ms)' },
    { key: 'whisper_decode_time_ms', label: 'Decode (ms)' },
    { key: 'audio_duration_ms', label: 'Audio (ms)' }
  ],
  // ONNX TTS RTF benchmark — one row per (engine, variant, backend, useGPU)
  // configuration. Mirrors the per-engine `aggregate-onnx-tts-rtf.js`
  // desktop aggregator's column set so the rendered Step Summary matches
  // what engineers see in `summarize` runs.
  'onnx-tts': [
    { key: 'real_time_factor', label: 'Mean RTF' },
    { key: 'rtf_p50', label: 'P50 RTF' },
    { key: 'rtf_p95', label: 'P95 RTF' },
    { key: 'wall_time_ms', label: 'Wall (ms)' },
    { key: 'cold_rtf', label: 'Cold RTF' },
    { key: 'model_load_ms', label: 'Load (ms)' },
    { key: 'tps', label: 'Tokens/sec' },
    { key: 'ttfa_ms', label: 'TTFA (ms)' },
    { key: 'inter_chunk_p95_ms', label: 'Inter-chunk P95 (ms)' }
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
     * @param {Object} [extra]          - Optional extra fields
     * @param {string} [extra.execution_provider] - 'cpu' | 'gpu' (or addon-specific)
     * @param {string} [extra.scenario] - Implementation group: 'image', 'bitnet',
     *                                    'tool-calling', etc. Defaults to 'default'.
     * @param {string} [extra.model]    - Model identifier for this row (e.g.
     *                                    'SmolVLM2-500M-Q8_0', 'Qwen3-1.7B-Q4_0').
     *                                    Surfaces in renderers as a Model column
     *                                    so reviewers can tell which weights
     *                                    produced each row.
     * @param {*}      [extra.input]    - Original test input snapshot
     * @param {*}      [extra.output]   - Generated output snapshot
     * @param {Object} [extra.quality]  - Quality metric pairs
     * @param {string} [extra.image_path] - Path to test image (OCR)
     */
    record (testName, metrics, extra) {
      const entry = {
        test: testName,
        // QVAC-17830: scenario is a top-level group key (e.g.
        // 'image', 'bitnet', 'tool-calling'). Tests opt into a
        // scenario so the report can split rows by implementation
        // when multiple test families share the same device column.
        // Defaults to 'default' so callers that don't care still
        // produce a row in the aggregated detail table.
        scenario: (extra && extra.scenario) || 'default',
        // Follow-up to QVAC-17830: optional model id so reports tell
        // reviewers which weights each row came from. Renderers fall
        // back to '-' when absent, so call sites that don't set it
        // still produce valid rows.
        model: (extra && extra.model) || null,
        execution_provider: (extra && extra.execution_provider) || null,
        metrics: {
          total_time_ms: null,
          detection_time_ms: null,
          recognition_time_ms: null,
          prefill_time_ms: null,
          decode_time_ms: null,
          vision_encode_time_ms: null,
          ttft_ms: null,
          generated_tokens: null,
          prompt_tokens: null,
          tps: null,
          text_regions: null,
          real_time_factor: null,
          sample_count: null,
          duration_ms: null,
          vision_time_ms: null,
          smollm2_compute_time_ms: null,
          smollm2_total_time_ms: null,
          ode_time_ms: null,
          backend: null,
          platform: null,
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

    /**
     * Set `device.gpu` after construction — e.g. once an addon has resolved
     * the actual GPU/backend name it ran on. Only fills a missing value, so a
     * richer name from the `detectDevice()` probe (nvidia-smi/lspci/vulkaninfo)
     * still wins; this is purely a fallback for minimal runners where those
     * probes return null even though inference ran on a GPU.
     *
     * @param {string} name - Resolved GPU/backend name (e.g. 'Vulkan0')
     */
    setDeviceGpu (name) {
      if (name && !device.gpu) device.gpu = name
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
      // Follow-up to QVAC-17830 (Olya, 14 May): mirror the mobile renderer
      // by surfacing device.gpu in the subtitle when populated. detectDevice()
      // already collects it via _detectGpu(); we just weren't rendering it
      // in the desktop per-job summary so reviewers had no GPU context for
      // the [GPU] rows. Falls back to the legacy subtitle when gpu is null.
      const gpuLabel = device.gpu ? ` | GPU: ${device.gpu}` : ''
      lines.push(`> Device: **${device.name}** (${device.platform}/${device.arch})${gpuLabel} | ` +
                  `Run: ${ci.run_number || 'local'} | ${startedAt}`)
      lines.push('')

      // Follow-up to QVAC-17830: include a Model column when any row in
      // this report carries a model id so reviewers can tell which weights
      // produced each row. Mirrors render-step-summary.js so desktop and
      // mobile per-job summaries share the same column layout. Drop the
      // column when no row sets it so existing addons stay pixel-identical.
      const includeModel = results.some(r => r && r.model)
      const baseHeader = ['Test']
      if (includeModel) baseHeader.push('Model')
      baseHeader.push('EP')
      const header = [...baseHeader, ...cols.map(c => c.label)]
      lines.push('| ' + header.join(' | ') + ' |')
      lines.push('| ' + header.map(() => '---').join(' | ') + ' |')

      for (const r of results) {
        const ep = r.execution_provider || '-'
        const vals = cols.map(c => {
          const v = r.metrics[c.key]
          if (v === null || v === undefined) return '-'
          if (c.format === 'percent' && typeof v === 'number') return (v * 100).toFixed(1) + '%'
          if (typeof v === 'number') return Number.isInteger(v) ? String(v) : v.toFixed(2)
          return String(v)
        })
        const cells = [r.test]
        if (includeModel) cells.push(r.model || '-')
        cells.push(ep, ...vals)
        lines.push('| ' + cells.join(' | ') + ' |')
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
            if (typeof v === 'number') {
              if (c.unit === 'raw') return v.toFixed(4)
              if (c.unit === 'cos-sim') return v.toFixed(8)
              return (v * 100).toFixed(1) + '%'
            }
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
