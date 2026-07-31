'use strict'
// MTP speed benchmark: measures what draft-mtp speculative decoding actually
// buys, as a WITHIN-RUN ratio of spec-off vs spec-on decode time, across a
// MODEL SIZE x PROMPT CLASS matrix.
//
// Why a matrix. Two variables dominate whether speculation pays, and measuring
// one point tells you almost nothing:
//   - Acceptance rate is prompt-dependent. The same 0.8B model accepts ~0.83 of
//     its drafts on a short factual question and ~0.37 on open-ended prose.
//   - Speculation's benefit scales with model size. Its win comes from
//     verifying N+1 tokens for roughly the cost of 1, which holds when decode
//     is memory-bandwidth-bound. On a small model the fixed per-decode cost
//     (graph launch, thread sync) dominates instead, and fabric's drafter
//     issues one llama_decode per drafted token -- so a round costs ~4 launches
//     to produce ~2 tokens against ~2 launches for plain decoding. That
//     overhead amortises as the model grows.
//
// Why a ratio and not absolute numbers: CI runners are shared and their
// absolute throughput drifts run-to-run by more than the effect being measured.
// The arms are therefore INTERLEAVED in time (plain, spec, plain, spec, ...) so
// drift and neighbour load hit both roughly equally. Verified: an isolated
// control reproduced the result with an ordering effect under 2%.
//
// Why ONE arm resident at a time (runPair): each arm is a separate addon with
// its own copy of the weights, so co-loading them needs 2x the model in memory.
// That was free on CPU but on an 8GB GPU it made the 4B cells spill to host
// memory and report a 3-4x "slowdown" that was pure measurement artifact
// (spec prefill 409ms vs plain 40ms — and speculation cannot touch prefill).
// Loading and unloading around every generation keeps peak memory at 1x the
// model while preserving the time-interleaving above. Load/unload sits outside
// the timed region, so it costs benchmark wall-clock, never accuracy.
// measureCell() now warns on that TTFT asymmetry so a spill can never again be
// mistaken for a result.
//
// Why decode WALL-CLOCK rather than stats.TPS: llama only books a decode as
// generation when the batch holds exactly one token, so before the addon
// corrected it, every verify batch landed in the PROMPT bucket -- TPS read 0
// for a full answer. Timing the work directly avoids depending on that
// bookkeeping, and the wall-clock cross-check below catches any recurrence.
//
// This test REPORTS timing; it does not gate on it. The only assertions are
// the deterministic ones (both arms produced output, speculation demonstrably
// on in one and off in the other). Greedy output-equivalence is pinned
// separately in mtp.test.js on a short prompt — deliberately NOT here, because
// a long open-ended prompt provokes backend-specific greedy tie-breaks.
//
// Opt-in via QVAC_RUN_MTP_BENCH=true, and excluded from the mobile group
// coverage requirement in scripts/generate-mobile-integration-tests.js
// (isOverrideOnly), so neither the normal desktop integration suite nor the
// Device Farm groups pay for it. The 2B/4B models are `warm: false` in
// models.manifest.json so CI never pre-downloads 6.7GB it will not use.

const path = require('bare-path')
const proc = require('bare-process')
const LlmLlamacpp = require('../../index.js')
const { ensureModel, safeTest } = require('./utils')
const { recordPerformance, isDarwinX64, isLinuxArm64 } = require('./_perf-helper.js')

const useCpu = isDarwinX64 || isLinuxArm64
const benchOptIn = !!(proc.env && proc.env.QVAC_RUN_MTP_BENCH === 'true')

// All Q8_0 so model SIZE is the only variable across rows. Mixing quants would
// confound it: lower-bit weights decode faster and push the workload toward
// compute-bound, which independently reduces speculative benefit.
//
// Deliberately no `url` fields: the mobile manifest generator discovers staging
// models by scanning for `{ name, url }` pairs, and this benchmark is
// desktop/opt-in only. Desktop resolves downloads from
// test/integration/models.manifest.json, where all three are SHA-pinned.
// `bytes` mirrors models.manifest.json and is used only for the memory report /
// spill warning, so a reader can compare peak resident against their VRAM.
const MODELS = [
  { label: '0.8B', name: 'Qwen3.5-0.8B-MTP-Q8_0.gguf', bytes: 833592128 },
  { label: '2B', name: 'Qwen3.5-2B-MTP-Q8_0.gguf', bytes: 2076674880 },
  { label: '4B', name: 'Qwen3.5-4B-MTP-Q8_0.gguf', bytes: 4610580192 }
]

// Three classes spanning the acceptance range, since acceptance is the
// dominant term in whether speculation pays.
const PROMPTS = [
  {
    label: 'short-factual',
    // Same prompt as mtp.test.js: a short, high-confidence answer where the
    // drafter is rarely wrong (~0.83 acceptance observed on 0.8B).
    messages: [
      { role: 'system', content: 'You are a helpful assistant.' },
      { role: 'user', content: 'What is the capital of France? Answer in one complete sentence.' }
    ]
  },
  {
    label: 'structured',
    // Highly predictable continuation: the token sequence is largely
    // determined by the format, which is the regime speculation is built for.
    messages: [
      { role: 'system', content: 'You are a helpful assistant.' },
      {
        role: 'user',
        content:
          'List the numbers from 1 to 40. Output exactly one line per number, formatted as "N. number N", with no commentary.'
      }
    ]
  },
  {
    label: 'open-ended',
    // Free-form prose: many plausible next tokens, so the drafter is wrong
    // often (~0.37 acceptance observed on 0.8B). MTP's unfavourable end.
    messages: [
      { role: 'system', content: 'You are a helpful assistant.' },
      {
        role: 'user',
        content:
          'Explain, in several complete sentences, how quantization reduces the memory footprint of a neural network and what trade-offs it introduces.'
      }
    ]
  }
]

// 128 rather than 256: the matrix is 3 models x 3 prompts x 3 pairs x (1 cheap
// warmup + 1 timed) per arm = 36 timed generations plus 36 short warmups, and
// the 4B arm would otherwise dominate the runtime. 128 still keeps decode well
// clear of prefill.
const N_PREDICT = 128
const CTX_SIZE = 2048
// Timed pairs per cell. Each pair is one spec-off + one spec-on run.
const PAIRS = 3

function baseConfig(withSpec) {
  const config = {
    device: useCpu ? 'cpu' : 'gpu',
    gpu_layers: '999',
    ctx_size: String(CTX_SIZE),
    n_predict: String(N_PREDICT),
    temp: '0',
    seed: '42',
    'reasoning-budget': '0',
    verbosity: '0'
  }
  if (withSpec) config['spec-type'] = 'draft-mtp'
  return config
}

// Exactly ONE addon is resident at any moment — see runPair(). Each load is a
// separate LlmLlamacpp with its own copy of the weights, so co-loading both
// arms would need 2x the model in memory.
async function loadAddon(modelPath, withSpec) {
  const addon = new LlmLlamacpp({
    files: { model: [modelPath] },
    config: baseConfig(withSpec),
    logger: { info() {}, error() {}, warn() {}, debug() {} },
    opts: { stats: true }
  })
  await addon.load()
  return addon
}

// Cheap warmup: a freshly loaded addon pays kernel/allocator warmup on its
// first generation, which would otherwise land inside the timed run. Only a few
// tokens are needed to warm that up, so override predict per request
// (RunOptions.generationParams.predict) instead of generating the full 128.
const WARMUP_PREDICT = 8

async function warmup(addon, messages) {
  const ticker = setInterval(() => {}, 50)
  try {
    const response = await addon.run(messages, {
      generationParams: { predict: WARMUP_PREDICT }
    })
    await response.onUpdate(() => {}).await()
  } finally {
    clearInterval(ticker)
  }
}

// One timed generation. Returns the output plus wall-clock total and the
// decode span (total minus time-to-first-token), which is the part MTP acts on.
async function timedRun(addon, messages) {
  const chunks = []
  const ticker = setInterval(() => {}, 50)
  // Date.now() to match the rest of the perf harness (_benchmark-perf.js,
  // _vlm-image-perf.js). Millisecond resolution is ample for runs measured in
  // seconds, and it avoids depending on a high-resolution clock API that the
  // Bare runtime may not expose.
  const startedAt = Date.now()
  try {
    const response = await addon.run(messages)
    await response
      .onUpdate((data) => {
        chunks.push(data)
      })
      .await()
    const totalMs = Date.now() - startedAt
    const stats = response.stats
    const ttftMs = Number(stats.TTFT) || 0
    return {
      output: chunks.join('').trim(),
      totalMs,
      decodeMs: totalMs > ttftMs ? totalMs - ttftMs : totalMs,
      ttftMs,
      stats
    }
  } finally {
    clearInterval(ticker)
  }
}

function median(values) {
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2
}

// Percentage spread of a series, used as a thermal-drift indicator.
function spreadPct(values) {
  const lo = Math.min(...values)
  const hi = Math.max(...values)
  return lo > 0 ? ((hi - lo) / lo) * 100 : 0
}

// Above this, per-run times varied enough that the cell should not be quoted
// without noting it. On a laptop GPU under sustained load, throttling is the
// usual cause.
const DRIFT_WARN_PCT = 15

// A spec-arm TTFT this many times the plain arm's means the two arms are not
// equally resident in device memory — see the spill note in measureCell().
// Heuristic: calibrated from a single observed 10x case, so it is a prompt to
// investigate, not a precise test.
const SPILL_TTFT_RATIO = 3

// Run ONE timed generation for each arm, loading and unloading around each so
// only one model is ever resident. The arms stay interleaved in time (plain,
// spec, plain, spec, ...) so thermal ramp is symmetric rather than a systematic
// bias against whichever arm would otherwise run last.
//
// Every load is cold, hence the warmup before each timed run. Load/unload time
// is deliberately outside timedRun(), so reloading costs benchmark wall-clock
// but never enters the measurement.
//
// Side benefit over the previous co-loaded design: each timed generation is now
// the FIRST on a fresh addon, so no per-addon state accumulates across runs.
// (Measured on the old design: implied-t_eval/wall was 0.96 on generation 1 but
// 1.09-1.10 from generation 2 onward on the speculative path.)
async function runPair(modelPath, prompt) {
  const plainAddon = await loadAddon(modelPath, false)
  let plain
  try {
    await warmup(plainAddon, prompt.messages)
    plain = await timedRun(plainAddon, prompt.messages)
  } finally {
    await plainAddon.unload().catch(() => {})
  }

  const specAddon = await loadAddon(modelPath, true)
  let spec
  try {
    await warmup(specAddon, prompt.messages)
    spec = await timedRun(specAddon, prompt.messages)
  } finally {
    await specAddon.unload().catch(() => {})
  }

  return { plain, spec }
}

// Measure one (model, prompt) cell. Returns the row for the summary table.
async function measureCell(t, modelPath, model, prompt) {
  {
    const plainRuns = []
    const specRuns = []
    for (let pair = 1; pair <= PAIRS; pair++) {
      const { plain, spec } = await runPair(modelPath, prompt)
      plainRuns.push(plain)
      specRuns.push(spec)
    }

    const plainDecode = median(plainRuns.map((r) => r.decodeMs))
    const specDecode = median(specRuns.map((r) => r.decodeMs))
    const plainWall = median(plainRuns.map((r) => r.totalMs))
    const specWall = median(specRuns.map((r) => r.totalMs))
    const lastSpec = specRuns[specRuns.length - 1]
    const lastPlain = plainRuns[plainRuns.length - 1]
    const acceptRate =
      lastSpec.stats.draftTotal > 0 ? lastSpec.stats.draftAccepted / lastSpec.stats.draftTotal : 0

    const row = {
      model: model.label,
      prompt: prompt.label,
      plainDecode,
      specDecode,
      // decodeMs subtracts TTFT, so it is only trustworthy while TTFT is. The
      // wall ratio depends on nothing the addon reports; if the two disagree,
      // believe wall-clock and suspect the stats.
      decodeRatio: specDecode > 0 ? plainDecode / specDecode : 0,
      wallRatio: specWall > 0 ? plainWall / specWall : 0,
      plainWall,
      specWall,
      acceptRate,
      draftAccepted: lastSpec.stats.draftAccepted,
      draftTotal: lastSpec.stats.draftTotal,
      plainTps: lastPlain.stats.TPS,
      specTps: lastSpec.stats.TPS,
      chars: lastSpec.output.length,
      backend: lastSpec.stats.backendDevice === 'gpu' ? 'gpu' : 'cpu'
    }

    console.log(
      `  [${model.label} / ${prompt.label}] decode ${plainDecode.toFixed(0)}ms -> ${specDecode.toFixed(0)}ms ` +
        `(${row.decodeRatio.toFixed(3)}x), wall ${row.wallRatio.toFixed(3)}x, ` +
        `accept ${lastSpec.stats.draftAccepted}/${lastSpec.stats.draftTotal} = ${acceptRate.toFixed(2)}, ` +
        `TPS ${Number(lastPlain.stats.TPS).toFixed(1)} -> ${Number(lastSpec.stats.TPS).toFixed(1)}`
    )

    // Per-run spread, so thermal drift is visible instead of hidden behind the
    // median. Mirrors the std-dev reporting in benchmarks/performance/
    // case-runner.js. The median stays the headline (robust to one outlier).
    const plainDecodes = plainRuns.map((r) => r.decodeMs)
    const specDecodes = specRuns.map((r) => r.decodeMs)
    row.plainSpreadPct = spreadPct(plainDecodes)
    row.specSpreadPct = spreadPct(specDecodes)
    console.log(
      `      per-run decode  plain [${plainDecodes.map((v) => v.toFixed(0)).join(', ')}] ` +
        `spread ${row.plainSpreadPct.toFixed(1)}%  |  ` +
        `spec [${specDecodes.map((v) => v.toFixed(0)).join(', ')}] spread ${row.specSpreadPct.toFixed(1)}%`
    )
    if (row.plainSpreadPct > DRIFT_WARN_PCT || row.specSpreadPct > DRIFT_WARN_PCT) {
      console.log(
        `      WARNING: per-run spread exceeds ${DRIFT_WARN_PCT}% — thermal throttling or a noisy ` +
          `host is likely; treat this cell's ratio as indicative only.`
      )
    }

    // Memory-spill detector. Speculation cannot affect PREFILL, so if the spec
    // arm's TTFT is far above the plain arm's, the two runs were not equally
    // resident in device memory — the spec model spilled to host RAM and is
    // partially offloaded. This is exactly how the first GPU run's 4B cells
    // were invalidated (plain TTFT 40ms vs spec 409ms, because the old design
    // co-loaded both arms and 2 x 4.6GB exceeded 8GB of VRAM). Kept as a
    // warning, not a failure: a spilled cell is a true observation about the
    // host, just not about MTP.
    const plainTtft = median(plainRuns.map((r) => r.ttftMs))
    const specTtft = median(specRuns.map((r) => r.ttftMs))
    row.plainTtft = plainTtft
    row.specTtft = specTtft
    row.spilled = plainTtft > 0 && specTtft > plainTtft * SPILL_TTFT_RATIO
    if (row.spilled) {
      console.log(
        `      WARNING: probable MEMORY SPILL — spec TTFT ${specTtft.toFixed(0)}ms vs plain ` +
          `${plainTtft.toFixed(0)}ms (>${SPILL_TTFT_RATIO}x). Prefill is untouched by speculation, so ` +
          `the arms were not equally resident. Model on disk: ${(model.bytes / 1e9).toFixed(2)}GB; ` +
          `peak resident should be 1x that. TREAT THIS CELL AS INVALID.`
      )
    }

    // Tag from the backend the addon actually resolved, NOT the requested
    // device: a box with no usable GPU asks for "gpu", ggml reports "No
    // devices found" and silently runs on CPU.
    const tag = `[${row.backend}] mtp-speedup ${model.label}/${prompt.label}`
    recordPerformance(`${tag} non-speculative`, lastPlain.totalMs, { stats: lastPlain.stats })
    recordPerformance(`${tag} draft-mtp`, lastSpec.totalMs, { stats: lastSpec.stats })

    // Deterministic assertions only — the ratios are DATA, never a gate.
    t.ok(
      lastPlain.output.length > 0,
      `[${model.label}/${prompt.label}] non-spec arm produced output`
    )
    t.ok(lastSpec.output.length > 0, `[${model.label}/${prompt.label}] spec arm produced output`)
    t.ok(
      lastSpec.stats.draftTotal > 0,
      `[${model.label}/${prompt.label}] spec arm really drafted (draftTotal=${lastSpec.stats.draftTotal})`
    )
    t.is(
      lastPlain.stats.draftTotal,
      0,
      `[${model.label}/${prompt.label}] non-spec arm drafted nothing`
    )
    return row
  }
}

safeTest(
  'MTP speed: decode-time ratio vs non-speculative across model sizes and prompt classes',
  { skip: !benchOptIn, timeout: 3_600_000 },
  async (t) => {
    const rows = []
    for (const model of MODELS) {
      const [modelName, dirPath] = await ensureModel({ modelName: model.name })
      const modelPath = path.join(dirPath, modelName)
      // Peak resident is ONE model at a time (runPair loads and unloads around
      // each generation), so compare this figure against available VRAM — not
      // 2x it, as the earlier co-loaded design required.
      console.log(
        `\n[${model.label}] ${(model.bytes / 1e9).toFixed(2)}GB on disk; peak resident ~1x that ` +
          `(one arm at a time)`
      )
      for (const prompt of PROMPTS) {
        rows.push(await measureCell(t, modelPath, model, prompt))
      }
    }

    console.log('')
    console.log('==== MTP speedup matrix (>1.000 means MTP is FASTER) ====')
    console.log('model  prompt          decode-x  wall-x  accept  drift%  backend  flags')
    for (const r of rows) {
      const flags = [
        r.spilled ? 'SPILL/INVALID' : '',
        r.plainSpreadPct > DRIFT_WARN_PCT || r.specSpreadPct > DRIFT_WARN_PCT ? 'DRIFT' : ''
      ]
        .filter(Boolean)
        .join(',')
      const drift = Math.max(r.plainSpreadPct, r.specSpreadPct)
      console.log(
        `${r.model.padEnd(6)} ${r.prompt.padEnd(15)} ` +
          `${r.decodeRatio.toFixed(3).padStart(8)} ${r.wallRatio.toFixed(3).padStart(7)} ` +
          `${r.acceptRate.toFixed(2).padStart(7)} ${drift.toFixed(1).padStart(7)} ` +
          `${r.backend.padStart(8)}  ${flags}`
      )
    }
    // spec-TPS is deliberately NOT in this table: it is a known-unreliable
    // statistic on the speculative path (over-counted t_eval). The ratios above
    // are wall-clock derived and independent of it.
    const valid = rows.filter((r) => !r.spilled)
    if (valid.length < rows.length) {
      console.log(
        `NOTE: ${rows.length - valid.length}/${rows.length} cell(s) flagged SPILL — excluded from the ` +
          `summary below. Re-run those on a host with more device memory.`
      )
    }
    if (valid.length > 0) {
      const best = valid.reduce((a, b) => (b.wallRatio > a.wallRatio ? b : a))
      console.log(
        `best valid cell: ${best.model}/${best.prompt} at ${best.wallRatio.toFixed(3)}x ` +
          `(acceptance ${best.acceptRate.toFixed(2)}, backend ${best.backend})`
      )
      console.log(
        `cells where MTP was faster: ${valid.filter((r) => r.wallRatio > 1).length}/${valid.length} valid`
      )
    }
  }
)
