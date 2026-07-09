'use strict'

// Shared runner for the mobile embed perf benchmark. Sharded into one test file
// per (model x quant x batchSize x flashAttn)
// (benchmark-perf-<model>-<quant>-bs<N>-fa<on|off>.test.js); this module holds
// the logic they all share. Underscore prefix keeps it out of the mobile test
// generator (it is not a *.test.js file).
//
// batchSize and flashAttn are the reload-heavy axes (each needs a fresh
// GGMLBert()+load()), so they are the shard key: one (batchSize, flashAttn) per
// shard. Each shard sweeps only device(cpu,gpu) INTERNALLY — device requires a
// fresh load (2 loads/session). One measured run per config (single-run), with
// the input sized to fill the batch. Embedding is a single prefill-only forward
// pass, so each config records prefill throughput (ppTPS), prefill latency (ms),
// and cosine similarity vs an in-run baseline (the first successful config in the
// shard). The axes come from the benchmark sweep grid, so the mobile sweep never
// drifts from the desktop one.

const fs = require('bare-fs')
const path = require('bare-path')
const os = require('bare-os')
const GGMLBert = require('../../index.js')
const { safeTest, downloadFile } = require('./utils')
const { attachSpecLogger } = require('./spec-logger')
const { recordPerformance, isMobile } = require('./_perf-helper.js')
const { matrix, PARAMETER_SWEEP } = require('./_benchmark-matrix.js')

// Inlined from benchmarks/performance/math.js + case-runner.js so this runner
// stays self-contained for the mobile Device Farm bundler (which only bundles
// test/integration). Kept byte-identical in behavior to the desktop copies.
function cosineSimilarity (a, b) {
  if (a.length !== b.length) {
    throw new Error(`Vector length mismatch: ${a.length} vs ${b.length}`)
  }
  let dotProduct = 0
  let normA = 0
  let normB = 0
  for (let i = 0; i < a.length; i++) {
    dotProduct += a[i] * b[i]
    normA += a[i] * a[i]
    normB += b[i] * b[i]
  }
  const denominator = Math.sqrt(normA) * Math.sqrt(normB)
  if (denominator < 1e-12) return 1.0 * Math.sign(dotProduct)
  return dotProduct / denominator
}

function average (values) {
  if (!values.length) return null
  let sum = 0
  for (const value of values) sum += value
  return sum / values.length
}

function stddev (values) {
  if (!values.length) return null
  if (values.length === 1) return 0
  const avg = average(values)
  let varianceSum = 0
  for (const value of values) {
    const diff = value - avg
    varianceSum += diff * diff
  }
  return Math.sqrt(varianceSum / values.length)
}

// The addon's prefill timer has ~millisecond resolution. A single short input
// prefills faster than it can measure, so the per-call prefill time can round to
// sub-millisecond. Treat prefill timing below this floor as unmeasured so ppTPS /
// latency report null for those configs instead of a fabricated value. Mirrors
// the desktop case-runner.
const MIN_RELIABLE_PREFILL_MS = 1

function reliablePrefillMs (prefillMs) {
  return prefillMs != null && prefillMs >= MIN_RELIABLE_PREFILL_MS ? prefillMs : null
}

// Prefill throughput (ppTPS) from this repeat's own token count and prefill time.
// The addon's tokens_per_second is derived from cumulative counters (see the
// delta handling in the run loop) and is not per-call, so it is not used here.
function prefillTokensPerSecond (deltaTokens, prefillMs) {
  if (deltaTokens == null || deltaTokens <= 0 || prefillMs == null || prefillMs <= 0) return null
  return (deltaTokens * 1000) / prefillMs
}

// Measured repetitions per config, reported as mean +/- stddev (matching the
// desktop sweep). Repeating on-device guards against a single shot skewed by
// mobile thermal throttling. A single warmup run primes GPU kernels/caches so
// rep 1 isn't a cold-start outlier.
const PERF_RUNS = 3
const PERF_WARMUP_RUNS = 1

function meanOf (values) {
  return values.length ? average(values) : null
}

function stdOf (values) {
  return values.length > 1 ? stddev(values) : null
}

const platform = os.platform()
const isDarwinX64 = platform === 'darwin' && os.arch() === 'x64'
const isLinuxArm64 = platform === 'linux' && os.arch() === 'arm64'

// darwin-x64 and linux-arm64 sweep CPU only, matching the integration suite's
// device list; everything else sweeps both.
const DEVICES = (isDarwinX64 || isLinuxArm64) ? ['cpu'] : PARAMETER_SWEEP.device

// Synthetic filler sized to the batch, so batch size is a real scaled-work
// throughput axis rather than a fixed tiny input in a bigger buffer. This is a
// SPEED benchmark, so only the token count matters, not the content. The
// chars/token needed to hit a target is measured per model against the addon
// tokenizer (measureCharsPerToken), and the filler targets a margin UNDER the
// batch, because the addon rejects a sequence whose token count reaches the
// batch/context. The run records the real inputTokens. Mirrors the desktop
// case-runner's filler. Every mobile batch (<= 2048) is <= both models' trained
// context, so one near-batch sentence fully fills the batch (no multi-sentence
// packing needed as on desktop's 4096/8192).
// DEFAULT is the fallback used only if the tokenizer measurement fails.
const DEFAULT_CHARS_PER_TOKEN = 4.1
const TOKEN_SAFETY_MARGIN = 16
const FILLER_HEAD = 'Some input. '
const FILLER_UNIT = 'Some more input. '

function buildFiller (targetChars) {
  let s = FILLER_HEAD
  while (s.length < Math.max(1, targetChars)) s += FILLER_UNIT
  return s.slice(0, Math.max(1, targetChars))
}

function inputForBatch (batchSize, charsPerToken) {
  return buildFiller(Math.round(Math.max(1, batchSize - TOKEN_SAFETY_MARGIN) * charsPerToken))
}

// Run a rough batch-sized filler through the loaded model and read total_tokens
// to get this model's real chars/token, so the batch-filling input is sized
// against the actual tokenizer rather than a hardcoded ratio. The probe uses the
// conservative default ratio so it stays under the batch/ctx (the model is loaded
// with ctx_size = batchSize); it is the first run on the model, so total_tokens is
// exactly the probe's token count. Returns the fallback on failure.
async function measureCharsPerToken (addon, batchSize) {
  try {
    const probe = inputForBatch(batchSize, DEFAULT_CHARS_PER_TOKEN)
    const r = await addon.run(probe)
    await r.await()
    const tokens = r.stats && r.stats.total_tokens
    return typeof tokens === 'number' && tokens > 0 ? probe.length / tokens : DEFAULT_CHARS_PER_TOKEN
  } catch (_) {
    return DEFAULT_CHARS_PER_TOKEN
  }
}

function modelSpec (modelName, quant) {
  const cell = matrix().find((c) => c.model === modelName && c.quant === quant)
  if (!cell) throw new Error(`No benchmark matrix cell for model "${modelName}" quant "${quant}"`)
  // One exact URL per cell (cell.file is the pinned HF filename). A wrong guess
  // would 404, and downloadFile does not retry a 404, so do not guess.
  const url = `https://huggingface.co/${cell.repo}/resolve/${cell.revision}/${cell.file}`
  return { id: cell.model, quant, name: cell.file, urls: [url] }
}

// Mirrors test/integration/utils.js ensureModel, but takes an ordered URL list
// (HF filename case varies per repo) and downloads into the shared model cache.
// The mobile framework patches utils.js's model dir to global.testDir (the
// app's writable Documents/files dir); __dirname here is the read-only bundle,
// so resolve the same writable location the regular tests use instead.
async function ensureBenchmarkModel (spec) {
  const modelDir = path.join(global.testDir || os.tmpdir(), 'test', 'model')
  const modelPath = path.join(modelDir, spec.name)
  if (fs.existsSync(modelPath)) {
    const stat = fs.statSync(modelPath)
    if (stat.size > 0) return modelPath
    fs.unlinkSync(modelPath)
  }
  fs.mkdirSync(modelDir, { recursive: true })
  console.log(`[download] Downloading benchmark model: ${spec.name}...`)
  await downloadFile(spec.urls, modelPath, { minBytes: 1024 })
  const stat = fs.statSync(modelPath)
  console.log(`[download] Model ready: ${(stat.size / 1024 / 1024).toFixed(1)}MB`)
  return modelPath
}

function buildConfig (device, batchSize, flashAttn, modelDir) {
  const config = {
    batch_size: String(batchSize),
    // Cap the context to the batch (the addon further caps to the trained ctx).
    // Without this, a model loads at its full trained context regardless of batch:
    // Qwen3-embedding-0.6B's trained context is 32768, which reserves a ~3GB
    // context/compute buffer and OOMs iOS, while embeddingGemma's 2048 fits. All
    // mobile batches are <= both models' trained contexts, so ctx_size = batch
    // keeps every model's buffer to tens-to-hundreds of MB. Mirrors the desktop
    // sweep's min(batch, trained-ctx) rule.
    ctx_size: String(batchSize),
    flash_attn: flashAttn,
    verbosity: '0',
    openclCacheDir: modelDir
  }
  if (device === 'cpu' || device === 'gpu') config.device = device
  return config
}

function normalizeEmbeddings (raw) {
  if (!Array.isArray(raw) || !Array.isArray(raw[0])) throw new Error('Invalid embedding response structure')
  return raw[0].map((vector) => Array.from(vector))
}

// avg cosine similarity of each sequence's embedding vs the baseline's, matching
// the desktop similarityStats.avg. Baseline is the first successful config in the
// shard, so it reads ~1.0 by construction.
function avgCosine (baseline, candidate) {
  if (!baseline || !candidate || baseline.length !== candidate.length || baseline.length === 0) return null
  let sum = 0
  for (let i = 0; i < baseline.length; i++) sum += cosineSimilarity(baseline[i], candidate[i])
  return sum / baseline.length
}

function labelFor (spec, device, batchSize, flashAttn) {
  return `[${spec.id} q=${spec.quant}] [${device}] [bs=${batchSize}] [fa=${flashAttn}]`
}

// Records a placeholder row with no metrics for a single config. The renderer
// shows any row without ppTPS/latency as Crashed, and the reporter flushes each
// record to console immediately, so a config that crashes the Device Farm
// session after its placeholder is written still leaves a Crashed row. A
// successful run records the real metrics afterwards, superseding the
// placeholder.
function recordCrashedPlaceholder (label, device, model) {
  recordPerformance(label, { deviceId: device, status: 'crashed', model })
}

// Registers the benchmark test for one (model x quant x batchSize x flashAttn),
// sweeping device internally. One Device Farm session per call. batchSize and
// flashAttn are fixed per shard (the reload-heavy axes live in the shard key),
// so this session does at most 2 model loads (one per device) — not one per
// batchSize/flashAttn — which is what keeps it inside the phone's memory budget.
// A config that fails to load or run is caught and reported as Crashed rather
// than aborting the sweep (a filled large batch that OOMs a tight device simply
// leaves a legitimate Crashed row for that config).
function benchmarkModel (modelName, quant, batchSize, flashAttn) {
  const spec = modelSpec(modelName, quant)
  safeTest(`Mobile perf benchmark: ${spec.id} q=${quant} bs=${batchSize} fa=${flashAttn} (ppTPS / latency / cosine)`, {
    timeout: 1_800_000,
    skip: !isMobile
  }, async (t) => {
    const specLogger = attachSpecLogger({ forwardToConsole: true })
    try {
      const modelPath = await ensureBenchmarkModel(spec)
      const modelDir = path.dirname(modelPath)

      // Once the model is downloaded, write a Crashed placeholder for EVERY
      // config before any load/run, so a hard native crash mid-sweep still
      // leaves rows for the rest. Real metrics supersede these. A download
      // failure throws above this loop and leaves no rows for this shard.
      for (const device of DEVICES) {
        recordCrashedPlaceholder(labelFor(spec, device, batchSize, flashAttn), device, `${spec.id}-${quant}`)
      }

      // Cosine baseline: the first successful config's embeddings (reads ~1.0
      // against itself); later configs compare their embeddings to it.
      let baselineEmbeddings = null
      // chars/token is a tokenizer (model) property, so measure it once per shard
      // on the first successful load and reuse it across devices.
      let charsPerToken = null

      for (const device of DEVICES) {
        let addon = null
        try {
          addon = new GGMLBert({
            files: { model: [modelPath] },
            config: buildConfig(device, batchSize, flashAttn, modelDir),
            logger: { error: () => {}, warn: () => {}, info: () => {}, debug: () => {} },
            opts: { stats: true }
          })
          await addon.load()
        } catch (loadErr) {
          t.comment(`[${spec.id} q=${quant}] [${device}] [bs=${batchSize}] [fa=${flashAttn}] load failed (reported as Crashed): ${loadErr && loadErr.message ? loadErr.message : loadErr}`)
          await (addon && addon.unload && addon.unload().catch(() => {}))
          continue
        }

        if (charsPerToken == null) charsPerToken = await measureCharsPerToken(addon, batchSize)

        const label = labelFor(spec, device, batchSize, flashAttn)
        try {
          // total_time_ms / total_tokens are CUMULATIVE for the loaded model's
          // lifetime (llama_perf_context, never reset between run() calls), so
          // each measured rep must report the delta since the previous run, not
          // the raw counter. These span the warmup and the measured reps because
          // they share one loaded model.
          let prevCumulativeMs = 0
          let prevCumulativeTokens = 0

          // Input is sized to fill the batch, so batch size measures real
          // scaled work (single run per config, matching the desktop sweep).
          const input = inputForBatch(batchSize, charsPerToken)

          // Warm up per loaded backend (discarded, never a measured rep) to
          // prime GPU kernels/caches so rep 1 isn't a cold-start outlier, and
          // seed the cumulative baseline so the first measured delta excludes it.
          try {
            for (let warm = 1; warm <= PERF_WARMUP_RUNS; warm++) {
              const w = await addon.run(input)
              await w.await()
              const ws = w.stats || {}
              if (ws.total_time_ms != null) prevCumulativeMs = ws.total_time_ms
              if (ws.total_tokens != null) prevCumulativeTokens = ws.total_tokens
              t.comment(`[${spec.id} q=${quant}] [${device}] warmup ${warm}/${PERF_WARMUP_RUNS} - perf NOT recorded`)
            }
          } catch (warmErr) {
            t.comment(`[${spec.id} q=${quant}] [${device}] warmup failed: ${warmErr && warmErr.message ? warmErr.message : warmErr}`)
          }

          try {
            const ppTpsValues = []
            const latencyValues = []
            let firstEmbeddings = null
            let inputTokens = null
            for (let rep = 1; rep <= PERF_RUNS; rep++) {
              const response = await addon.run(input)
              const raw = await response.await()
              const stats = response.stats || {}
              // Per-call cost = delta of the cumulative counters since the
              // previous run (warmup or prior rep). Advance the baseline BEFORE
              // validating embeddings: the addon counter advanced regardless of
              // validation, so a throw must not leave the next rep double-counting
              // this run.
              const cumulativeMs = stats.total_time_ms
              const cumulativeTokens = stats.total_tokens
              const deltaMs = cumulativeMs != null ? cumulativeMs - prevCumulativeMs : null
              const deltaTokens = cumulativeTokens != null ? cumulativeTokens - prevCumulativeTokens : null
              if (cumulativeMs != null) prevCumulativeMs = cumulativeMs
              if (cumulativeTokens != null) prevCumulativeTokens = cumulativeTokens
              const embeddings = normalizeEmbeddings(raw)
              if (!firstEmbeddings) firstEmbeddings = embeddings
              if (inputTokens == null && deltaTokens != null) inputTokens = deltaTokens
              const latencyMs = reliablePrefillMs(deltaMs)
              const ppTps = latencyMs != null ? prefillTokensPerSecond(deltaTokens, latencyMs) : null
              if (ppTps != null) ppTpsValues.push(ppTps)
              if (latencyMs != null) latencyValues.push(latencyMs)
            }

            // Cosine baseline is the first successful config's first-rep
            // embeddings; reps of the same config are numerically identical, so
            // one rep's embeddings suffice for the comparison.
            let cosine = null
            if (!baselineEmbeddings) {
              baselineEmbeddings = firstEmbeddings
              cosine = 1
            } else {
              cosine = avgCosine(baselineEmbeddings, firstEmbeddings)
            }

            t.comment(recordPerformance(label, {
              deviceId: device,
              ppTps: meanOf(ppTpsValues),
              ppTpsStd: stdOf(ppTpsValues),
              latencyMs: meanOf(latencyValues),
              latencyMsStd: stdOf(latencyValues),
              cosine,
              inputTokens,
              // Richest series: ppTPS can be null on a zero-prefill-time
              // edge while latency is still valid, so don't let it under-
              // report the sample count.
              sampleCount: Math.max(ppTpsValues.length, latencyValues.length),
              status: 'ok',
              model: `${spec.id}-${quant}`
            }))
            t.ok(firstEmbeddings.length > 0, `${label} produced embeddings`)
          } catch (runErr) {
            t.comment(`${label} run failed (reported as Crashed): ${runErr && runErr.message ? runErr.message : runErr}`)
          }
        } finally {
          await addon.unload().catch(() => {})
        }
      }
    } finally {
      specLogger.release()
    }
  })
}

module.exports = { benchmarkModel, modelSpec }
