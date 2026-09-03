// Calibration harness for assessModelFit.
//
// Loads representative catalog models, measures resident and peak memory around
// real operations, and derives the coefficients in
// `src/resources/model-fit/calibration/<platform>.ts`.
//
// Run from the package root, on the platform being calibrated, with bare ≥ 1.30
// (which runs TypeScript directly via type-stripping — the version the
// `engines` field already requires):
//
//   npm run build
//   bare scripts/calibrate-model-fit.ts            # measure and print
//   bare scripts/calibrate-model-fit.ts --write    # also rewrite the fixture
//
// Models are downloaded on first run and cached, so the first pass is slow and
// needs registry access. See calibration/METHODOLOGY.md for what the numbers
// mean and how the held-out check works, and "Windows" there for why that
// platform loads weights with `load_mode: 'none'`.

import os from 'bare-os'
import fs from 'bare-fs'
import path from 'bare-path'
import {
  registerPlugin,
  loadModel,
  completion,
  unloadModel,
  getSystemResources
} from '../dist/index.js'
import * as catalog from '../dist/models/registry/index.js'
import { MODEL_RESOURCE_PROFILES } from '../dist/models/registry/resource-profiles.js'
import { kvElementBytes, kvCacheBytesForWidth } from '../dist/resources/model-fit/estimators/llm.js'
import { fitResidentMemory, kvObservation } from '../dist/resources/model-fit/calibration/fit.js'
import { llmPlugin } from '../dist/plugins/builtin/llamacpp-completion/plugin.js'
import type { GgufFacts } from '../dist/schemas/model-resource-profile.js'
import type { PlatformCalibration } from '../dist/resources/model-fit/types.js'

declare const Bare: { argv: string[]; exit(code?: number): never }

const SAMPLE_INTERVAL_MS = 25
const SETTLE_MS = 250

// Two contexts per model so fixed overhead and the per-token compute buffer can
// be separated; a single point cannot tell them apart.
const CONTEXTS = [512, 8192]

// Every point is measured this many times. Single-shot loads were observed to
// vary by up to ~100 MiB run to run; all repeats enter the fit, and the upper
// bound is floored at the worst point seen.
const REPEATS = 3

// llama.cpp allocates the whole context at load — KV cache, engine overhead
// and compute buffers included — so the RSS delta during a completion should
// be near zero. A working delta above this threshold means the engine's
// allocation behaviour changed and this methodology needs re-checking.
const WORKING_DRIFT_WARN_BYTES = 64 * 1024 * 1024

// The KV cache grows by a known amount between the two contexts, so the deltas
// must too. A shortfall means the wrong KV width, or a counter missing memory.
const KV_OBSERVATION_FLOOR = 0.9

// Small, medium, large — plus one held out of the fit entirely, used only to
// check that the derived upper bound actually holds.
const FIT_MODELS = ['QWEN3_600M_INST_Q4', 'LLAMA_3_2_1B_INST_Q4_0', 'QWEN3_4B_INST_Q4_K_M']
const HELD_OUT_MODEL = 'QWEN3_8B_INST_Q4_K_M'

interface Measurement {
  name: string
  contextTokens: number
  artifactBytes: number
  facts: GgufFacts
  persistentBytes: number
  workingBytes: number
}

interface FitPoint extends Measurement {
  kvBytes: number
}

function rssBytes() {
  const usage = os.memoryUsage()
  return usage && usage.rss > 0 ? usage.rss : 0
}

// Load anonymously wherever the CPU backend is forced. It copies mapped weights
// into its own buffers, so RSS counts them twice — linux read 1.7x the artifact
// — while win32 prefetches to the standby list and counts almost none. The
// anonymous copy is the memory the system must actually find; the mapped pages
// the default keeps are file-backed and evictable.
function calibrationLoadMode(platform: string) {
  return forcesCpu(platform) ? 'none' : undefined
}

function createSampler() {
  const samples: number[] = []
  let timer: ReturnType<typeof setTimeout> | null = null
  let running = false

  function tick() {
    if (!running) return
    const rss = rssBytes()
    if (rss > 0) samples.push(rss)
    timer = setTimeout(tick, SAMPLE_INTERVAL_MS)
    if (timer && typeof timer.unref === 'function') timer.unref()
  }

  return {
    start() {
      running = true
      tick()
    },
    stop() {
      running = false
      if (timer) clearTimeout(timer)
      const rss = rssBytes()
      if (rss > 0) samples.push(rss)
      return samples.length > 0 ? Math.max(...samples) : 0
    }
  }
}

function settle() {
  return new Promise((resolve) => setTimeout(resolve, SETTLE_MS))
}

// A stalled download or a wedged engine call would otherwise run to the job
// timeout while holding an exclusive drained host, so every phase is bounded.
const LOAD_TIMEOUT_MS = 30 * 60 * 1000
const COMPLETION_TIMEOUT_MS = 15 * 60 * 1000
const UNLOAD_TIMEOUT_MS = 5 * 60 * 1000

function withTimeout<T>(promise: Promise<T>, label: string, timeoutMs: number, hint: string) {
  let timer: ReturnType<typeof setTimeout>
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(new Error(`${label} did not finish within ${timeoutMs / 60000} minutes; ${hint}`))
    }, timeoutMs)
    if (timer && typeof timer.unref === 'function') timer.unref()
  })
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer))
}

function metricValue(metric: unknown) {
  const m = metric as { status?: string; value?: unknown } | undefined
  return m?.status === 'supported' ? m.value : undefined
}

// Largest dedicated GPU first. The win25 runner reports an Intel iGPU ahead of
// its RTX 4000, and first-wins named the iGPU as the device on every fixture.
function byCapability(gpuList: readonly Record<string, unknown>[]) {
  return [...gpuList].sort((a, b) => {
    const dedicated = (gpu: Record<string, unknown>) =>
      metricValue(gpu.unifiedMemory) === false ? 1 : 0
    const memory = (gpu: Record<string, unknown>) =>
      (metricValue(gpu.memoryTotalBytes) as number) ?? 0
    return dedicated(b) - dedicated(a) || memory(b) - memory(a)
  })
}

// Bytes resident on the GPU the engine would pick. Read through the collector
// so the calibration and the estimator agree on which device counts and on
// whether its readings are device-scoped at all.
async function readGpuUsedBytes() {
  // `sample: true` is required: the default response carries capabilities only.
  const resources = await getSystemResources({ sample: true })
  const gpus = resources.capabilities.gpus
  const samples = resources.sample?.gpus
  if (gpus.status !== 'supported' || samples?.status !== 'supported') {
    throw new Error('no GPU sample is available, so a GPU pass cannot be measured')
  }

  for (const gpu of byCapability(gpus.value as unknown as Record<string, unknown>[])) {
    const sample = samples.value.find((entry) => entry.id === (gpu.id as string))
    if (sample?.memoryUsedBytes.status === 'supported') return sample.memoryUsedBytes.value
  }

  // Returning 0 here would read as "nothing allocated" and quietly fit garbage.
  throw new Error(
    'no GPU reports device-scoped used memory, so this host cannot be calibrated for GPU residency'
  )
}

// The driver frees device memory asynchronously, so a fixed settle can read a
// baseline that still holds the previous load: one repeat measured 1781 MiB
// against 690 for the same model. Wait for two readings to agree instead.
const GPU_SETTLE_TOLERANCE_BYTES = 16 * 1024 * 1024
const GPU_SETTLE_ATTEMPTS = 40

async function settledGpuUsedBytes() {
  let previous = await readGpuUsedBytes()
  for (let attempt = 0; attempt < GPU_SETTLE_ATTEMPTS; attempt++) {
    await settle()
    const current = await readGpuUsedBytes()
    if (Math.abs(current - previous) <= GPU_SETTLE_TOLERANCE_BYTES) return current
    previous = current
  }
  throw new Error(
    `GPU memory did not settle within ${(GPU_SETTLE_ATTEMPTS * SETTLE_MS) / 1000}s; the device is not idle enough to calibrate`
  )
}

// Label for the backend in play, recorded with the coefficients because the
// buffers they measure are allocated by the backend, and used as the GPU
// fixture key. Must stay in step with `GPU_BACKENDS` in `assess.ts`: the
// estimator derives the same key the same way, and a fixture filed under a
// backend the engine does not use would be served to hosts it never measured.
function detectBackend(gpuList: readonly Record<string, unknown>[]) {
  for (const gpu of byCapability(gpuList)) {
    const drivers = (gpu.drivers ?? {}) as Record<
      string,
      { status: string; value?: unknown } | undefined
    >
    for (const name of ['metal', 'vulkan', 'rocm', 'cuda', 'levelZero', 'opencl']) {
      if (drivers[name]?.status === 'supported' && drivers[name].value) return name
    }
  }
  return 'cpu'
}

function gpuName(gpuList: readonly Record<string, unknown>[]) {
  for (const gpu of byCapability(gpuList)) {
    const name = metricValue(gpu.name)
    if (typeof name === 'string' && name) return name
  }
  return undefined
}

/**
 * KV-cache bytes the engine allocated for one model at one context, computed
 * by the estimator's own exported accounting rather than a local copy — a copy
 * drifted from `estimators/llm.ts` once already.
 *
 * The residuals this harness fits describe everything *except* the cache, so a
 * cache whose size the file does not state exactly (an engine-owned layer
 * pattern or hybrid block choice) cannot be subtracted. That surfaces as a
 * non-degenerate range, and the harness stops: calibration models must be
 * dense.
 */
function exactKvBytes(
  name: string,
  facts: GgufFacts,
  contextTokens: number,
  bytesPerElement: number
) {
  const kv = kvCacheBytesForWidth(facts, contextTokens, bytesPerElement)
  if (kv.lower !== kv.upper) {
    throw new Error(
      `${name}'s KV cache is not exactly determined by the file (bounds span ${kv.lower}–${kv.upper} bytes); part of its layout is engine-owned, so it cannot be subtracted from a measurement. Use a dense model for calibration.`
    )
  }
  return kv.lower
}

// RSS cannot observe VRAM, so these platforms calibrate CPU-resident execution.
// Must be `device`, not `gpu_layers: 0`: the addon takes its KV default from the
// backend `device` selects, so a GPU device builds q8_0 against a subtracted f16.
function forcesCpu(platform: string) {
  return platform.startsWith('linux') || platform.startsWith('win32') || platform === 'darwin-x64'
}

async function measure(
  name: string,
  contextTokens: number,
  cpuForced: boolean,
  loadMode: 'none' | undefined,
  gpuPass: boolean
): Promise<Measurement> {
  const model = (catalog as Record<string, { sha256Checksum: string } | undefined>)[name]
  if (!model) throw new Error(`unknown catalog constant: ${name}`)

  const profile = MODEL_RESOURCE_PROFILES[model.sha256Checksum]
  if (!profile?.ggufFacts) throw new Error(`no GGUF facts for ${name}`)

  await settle()
  const before = gpuPass ? await settledGpuUsedBytes() : rssBytes()

  const modelId = await withTimeout(
    loadModel({
      modelSrc: model,
      modelConfig: {
        ctx_size: contextTokens,
        ...(cpuForced && { device: 'cpu' }),
        ...(loadMode && { load_mode: loadMode })
      }
    }),
    `loading ${name}`,
    LOAD_TIMEOUT_MS,
    "a registry download has likely stalled. Check the registry's reachability from this host."
  )

  await settle()
  const afterLoad = gpuPass ? await settledGpuUsedBytes() : rssBytes()

  // The RSS sampler cannot follow device memory — that counter is only readable
  // through an async collector call. It costs nothing to skip: llama.cpp
  // allocates the whole context at load, and every CPU point measured a working
  // delta of 0.
  const sampler = gpuPass ? undefined : createSampler()
  sampler?.start()
  let peak = afterLoad
  try {
    const result = completion({
      modelId,
      history: [{ role: 'user', content: 'Summarize the history of cartography.' }],
      stream: false,
      params: { maxTokens: 128 }
    })
    await withTimeout(
      result.response,
      `completion for ${name}`,
      COMPLETION_TIMEOUT_MS,
      'the weights loaded, so this is a wedged engine call rather than a download stall.'
    )
  } finally {
    if (sampler) peak = sampler.stop()
  }

  await withTimeout(
    unloadModel({ modelId }),
    `unloading ${name}`,
    UNLOAD_TIMEOUT_MS,
    'the engine call is wedged.'
  )
  await settle()

  return {
    name,
    contextTokens,
    artifactBytes: profile.artifactBytes,
    facts: profile.ggufFacts,
    persistentBytes: Math.max(0, afterLoad - before),
    workingBytes: Math.max(0, peak - afterLoad)
  }
}

function fixtureSource(platform: string, calibration: PlatformCalibration) {
  // Unquote the keys only. Values stay JSON-quoted, which is already valid
  // TypeScript; replacing every quote breaks any value containing one, and
  // prettier settles the house quote style afterwards anyway.
  const json = JSON.stringify(calibration, null, 2).replace(/"([a-zA-Z]+)":/g, '$1:')
  return `import type { PlatformCalibration } from '@/resources/model-fit/types'

/**
 * ${platform} coefficients.
 *
 * Generated by \`scripts/calibrate-model-fit.ts\`; see \`METHODOLOGY.md\` next
 * to this file for how the numbers are derived and validated.
 */
export const ${platform.toUpperCase().replace(/-/g, '_')}_CALIBRATION: PlatformCalibration = ${json}
`
}

async function main() {
  const write = Bare.argv.includes('--write')
  // `--gpu` calibrates the same models resident on the GPU instead: no device
  // override, the SDK's own load mode, and device memory as the counter.
  const gpuPass = Bare.argv.includes('--gpu')
  const platform = `${os.platform()}-${os.arch()}`
  console.log(`calibrating ${platform}${gpuPass ? ' (GPU-resident)' : ''}`)

  const loadMode = gpuPass ? undefined : calibrationLoadMode(platform)
  if (loadMode) {
    console.log(`weights loaded with load_mode '${loadMode}' — see METHODOLOGY.md, "Windows"`)
  }

  registerPlugin(llmPlugin)

  // The fit subtracts the KV cache from each load's persistent delta, so the
  // cache subtracted has to be the one the engine actually allocated. A fixed
  // f16 assumption over-subtracts by nearly 2x on a Metal or Vulkan backend —
  // and since the error scales with context, it lands in the per-token slope
  // rather than the intercept, corrupting the very coefficient the two-context
  // design exists to isolate.
  const resources = await getSystemResources()
  const gpus = resources.capabilities.gpus
  const gpuList = gpus.status === 'supported' ? gpus.value : []
  const cpuForced = !gpuPass && forcesCpu(platform)
  // `device: 'cpu'` selects the CPU backend, and with it the f16 KV default.
  const hasGpu = gpuList.length > 0 && !cpuForced
  const backend = cpuForced ? 'cpu' : detectBackend(gpuList)
  const device = gpuName(gpuList)
  console.log(
    `backend: ${backend}${device ? ` (${device})` : ''}${cpuForced ? ' — GPU offload disabled for calibration' : ''}`
  )

  const mib = (n: number) => (n / 1024 / 1024).toFixed(0)

  // The first load in a process reads high — arenas and caches that later loads
  // reuse — and these coefficients describe warm loads. Left in, it landed as a
  // 30% spread the repeat check reported as a busy host, and skewed the linux
  // weight ratio to 1.7. Warm up on the smallest model and throw it away.
  console.log('warm-up load (not measured)')
  await measure(FIT_MODELS[0]!, CONTEXTS[0]!, cpuForced, loadMode, gpuPass)

  const elementWidths = new Set<number>()
  const measurements: FitPoint[] = []
  for (const name of FIT_MODELS) {
    for (const contextTokens of CONTEXTS) {
      for (let repeat = 0; repeat < REPEATS; repeat++) {
        const measurement = await measure(name, contextTokens, cpuForced, loadMode, gpuPass)
        // `.lower` is the width a GPU backend defaults to (q8_0), and equals
        // f16 when no GPU is reported — what the engine allocates in each
        // case, not an optimistic bound borrowed from the estimator's range.
        const bytesPerElement = kvElementBytes(measurement.facts, hasGpu).bytes.lower
        elementWidths.add(bytesPerElement)
        const kvBytes = exactKvBytes(name, measurement.facts, contextTokens, bytesPerElement)
        measurements.push({ ...measurement, kvBytes })
        console.log(
          `  ${name} @ ${contextTokens} (${repeat + 1}/${REPEATS}): persistent ${mib(measurement.persistentBytes)} MiB, working ${mib(measurement.workingBytes)} MiB, kv ${mib(kvBytes)} MiB`
        )
        if (measurement.workingBytes > WORKING_DRIFT_WARN_BYTES) {
          console.log(
            `    warning: working delta is ${mib(measurement.workingBytes)} MiB — the engine no longer allocates everything at load, so the persistent-based fit under-describes the peak`
          )
        }
      }
    }
  }

  if (elementWidths.size > 1) {
    console.log(
      `\nwarning: the fit mixes KV element widths (${[...elementWidths].join(', ')} bytes), so the points do not describe a single cache type`
    )
  }

  // Judge the counter before the fit: the KV cache grows by an exactly known
  // amount between the two contexts, and every sound counter has to see it.
  const observation = kvObservation(measurements)
  console.log('\nKV growth between contexts, computed vs observed:')
  for (const growth of observation.models) {
    const model = measurements.find((m) => m.artifactBytes === growth.artifactBytes)
    console.log(
      `  ${model?.name ?? mib(growth.artifactBytes) + ' MiB'}: kv +${mib(growth.kvDeltaBytes)} MiB, persistent +${mib(growth.observedDeltaBytes)} MiB (${((growth.observedDeltaBytes / growth.kvDeltaBytes) * 100).toFixed(0)}%)`
    )
  }
  if (observation.ratio < KV_OBSERVATION_FLOOR) {
    // The same shortfall read against the other width the engine could have
    // chosen: a ratio near 1 there names the cause outright.
    const width = Math.max(...elementWidths)
    const other = kvElementBytes(measurements[0]!.facts, !hasGpu).bytes.lower
    const otherRatio = (observation.ratio * width) / other
    console.log(
      `\nthe persistent deltas grew by ${(observation.ratio * 100).toFixed(0)}% of the KV cache computed at ${width} bytes per element (floor ${KV_OBSERVATION_FLOOR * 100}%); at ${other} bytes per element the same growth reads as ${(otherRatio * 100).toFixed(0)}%. Either the engine built a different cache type than the one subtracted, or RSS is missing allocation; nothing fitted on these points is an upper bound. No fixture written.`
    )
    Bare.exit(1)
  }

  // Fail loudly rather than fitting nonsense: a load that measured smaller
  // than the KV cache it supposedly allocated means the assumed cache type
  // does not match what the engine did.
  const negative = measurements.filter((m) => m.persistentBytes - m.kvBytes < 0)
  if (negative.length > 0) {
    // Weights far below artifact size with a GPU present means the model went
    // to discrete GPU memory, which process RSS cannot observe; RSS-based
    // calibration only works on unified-memory or CPU-resident hosts.
    const offloaded = hasGpu && measurements.some((m) => m.persistentBytes < m.artifactBytes / 2)
    console.log(
      offloaded
        ? `\n${negative.length} of ${measurements.length} points measured less persistent memory than the KV cache being subtracted: the model is in discrete GPU memory, which process RSS cannot observe. This methodology only calibrates unified-memory or CPU-resident hosts. No fixture written.`
        : `\n${negative.length} of ${measurements.length} points measured less persistent memory than the KV cache being subtracted: the assumed cache type does not match what the engine allocated. No fixture written.`
    )
    Bare.exit(1)
  }

  const fit = fitResidentMemory(measurements)
  if (!fit) {
    console.log(
      '\nthe measurement design cannot separate the weight ratio, fixed overhead and per-token slope (degenerate fit). No fixture written.'
    )
    Bare.exit(1)
  }
  console.log(
    `\nfit: weightRatio ${fit.weightRatio.toFixed(3)}, fixed ${mib(fit.fixedBytes)} MiB, perToken ${fit.perTokenBytes.toFixed(0)} B, worst excess ${mib(fit.worstExcessBytes)} MiB`
  )

  // Busy-host tripwires. Co-scheduled work cannot inflate this process's RSS,
  // but memory pressure can evict its mapped pages and DEFLATE the persistent
  // deltas — the dangerous direction for an upper bound. Deflation shows up as
  // a weight ratio well below 1 (quiet-host runs measured ~1.0) or as repeats
  // of the same point disagreeing; neither aborts, because a platform could
  // legitimately page weights lazily, but a fixture from a warned run should
  // not ship without a quiet re-run.
  if (fit.weightRatio < 0.9) {
    console.log(
      `\nwarning: weightRatio ${fit.weightRatio.toFixed(3)} — resident weights landed well below artifact size. Either this platform pages weights lazily, or the host was under memory pressure during the run. Re-run on an idle host before trusting this fixture.`
    )
  }
  for (const name of FIT_MODELS) {
    for (const contextTokens of CONTEXTS) {
      const repeats = measurements.filter(
        (m) => m.name === name && m.contextTokens === contextTokens
      )
      const values = repeats.map((m) => m.persistentBytes)
      const spread = Math.max(...values) - Math.min(...values)
      const mean = values.reduce((total, v) => total + v, 0) / values.length
      if (mean > 0 && spread / mean > 0.15) {
        console.log(
          `\nwarning: ${name} @ ${contextTokens} repeats spread ${mib(spread)} MiB (${((spread / mean) * 100).toFixed(0)}% of mean) — the host does not look idle. Re-run on a quiet machine before trusting this fixture.`
        )
      }
    }
  }

  const calibration: PlatformCalibration = {
    weightUpperCoeff: Number(Math.max(1, fit.weightRatio).toFixed(3)),
    fixedOverheadBytes: {
      lower: Math.round(fit.fixedBytes * 0.8),
      // Floored at the worst point observed: an upper bound that does not
      // cover a measurement is not an upper bound.
      upper: Math.round((fit.fixedBytes + fit.worstExcessBytes) * 1.2)
    },
    computeBufferBytesPerToken: {
      lower: Math.round(fit.perTokenBytes * 0.8),
      upper: Math.round(fit.perTokenBytes * 1.2)
    },
    // Audio coefficients need a whisper pass; left at zero until that runs.
    // `estimateWhisper` refuses to consume the zeros, so audio workloads
    // assess as unknown rather than as a confident under-estimate.
    audioWindowBytes: { lower: 0, upper: 0 },
    audioStreamingBytes: { lower: 0, upper: 0 },
    validated: false,
    ...(loadMode && {
      notes: [
        `weights were loaded with load_mode '${loadMode}' so RSS counted them in full at load; a mapped weight set keeps at most the artifact size resident, so weightUpperCoeff remains an upper bound for the default mmap load`
      ]
    }),
    measuredAt: new Date().toISOString().slice(0, 10),
    measuredOn: {
      backend,
      ...(device ? { device } : {}),
      kvElementBytes: Math.max(...elementWidths)
    }
  }

  console.log('\nderived:', JSON.stringify(calibration, null, 2))

  // Predict with the width this run actually allocated, not the estimator's f16
  // upper end. Using f16 here on a q8_0 backend would pad the prediction by the
  // whole cache-type spread and let weak coefficients through the gate; the
  // point is to test the fit, not the conservatism of the range. The held-out
  // model is measured as many times as a fit point, against the worst total.
  let heldOutWorstTotal = 0
  let heldOutKv = 0
  let heldOutArtifactBytes = 0
  for (let repeat = 0; repeat < REPEATS; repeat++) {
    const heldOut = await measure(HELD_OUT_MODEL, CONTEXTS[1]!, cpuForced, loadMode, gpuPass)
    const heldOutWidth = kvElementBytes(heldOut.facts, hasGpu).bytes.lower
    heldOutKv = exactKvBytes(HELD_OUT_MODEL, heldOut.facts, CONTEXTS[1]!, heldOutWidth)
    heldOutArtifactBytes = heldOut.artifactBytes
    heldOutWorstTotal = Math.max(heldOutWorstTotal, heldOut.persistentBytes + heldOut.workingBytes)
  }
  const predictedUpper =
    heldOutArtifactBytes * calibration.weightUpperCoeff +
    calibration.fixedOverheadBytes.upper +
    calibration.computeBufferBytesPerToken.upper * CONTEXTS[1]! +
    heldOutKv
  const holds = heldOutWorstTotal <= predictedUpper

  console.log(
    `\nheld-out ${HELD_OUT_MODEL}: worst measured ${(heldOutWorstTotal / 2 ** 30).toFixed(2)} GiB vs predicted upper ${(predictedUpper / 2 ** 30).toFixed(2)} GiB — ${holds ? 'PASS' : 'FAIL'}`
  )
  calibration.validated = holds
  if (!holds) {
    console.log('the held-out peak exceeded the upper bound; do not ship these coefficients')
  }

  if (write) {
    // A GPU pass is keyed by backend as well as platform, so it neither
    // overwrites the CPU fixture nor claims to cover another backend.
    const fixtureKey = gpuPass ? `${platform}-${backend}` : platform
    const target = path.join(
      os.cwd(),
      'src',
      'resources',
      'model-fit',
      'calibration',
      `${fixtureKey}.ts`
    )
    fs.writeFileSync(target, fixtureSource(fixtureKey, calibration))
    console.log(`\nwrote ${target}`)
    console.log('remember to add the platform to calibration/index.ts and run prettier')
  } else {
    console.log('\nre-run with --write to update the fixture')
  }

  // Exit explicitly either way. The registry client keeps handles open, so a
  // returning main() leaves the process alive until the job times out — and the
  // fixture, already written, never reaches the upload step.
  Bare.exit(holds ? 0 : 1)
}

main().catch((error) => {
  console.error('calibration failed:', error)
  Bare.exit(1)
})
