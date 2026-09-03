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
// mean and how the held-out check works. On Windows the run stops before any
// load unless bare-os exposes the commit charge — see "Windows" there.

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

// The KV cache grows by an exactly known amount between the two contexts, so
// the persistent deltas must grow by at least that much. A counter that sees
// less is reporting residency, not allocation, and nothing fitted on it can be
// an upper bound. The win32 working set measured ~0.56 (see METHODOLOGY.md).
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

/**
 * The process counter every delta in a run reads, and the load mode that lets
 * it see the weights. Resolved once: mixing counters would fit nonsense.
 */
interface MemoryMeter {
  counter: 'rss' | 'committed'
  /** Passed on every load; absent keeps the SDK default (mmap). */
  loadMode?: 'none'
  read(): number
}

function positive(value: number | undefined) {
  return value !== undefined && value > 0 ? value : 0
}

/**
 * darwin/linux read RSS: touched pages, file-backed weights included, and it
 * holds once a load settles (darwin-arm64 measured weights at 1.0× artifact).
 *
 * win32's `rss` is `GetProcessMemoryInfo().WorkingSetSize` — pages the OS is
 * currently keeping resident, which it trims while they stay allocated. The
 * CPU-forced CI run saw a 1152 MiB KV cache as 717 MiB and 2.4 GiB of weights
 * as ~0. The commit charge (`PrivateUsage`) survives trimming but never counts
 * file-backed mappings, so Windows reads it and loads weights with `load_mode:
 * 'none'`, which reads them into anonymous memory. The default mmap load can
 * keep at most the artifact size resident, so a ratio measured this way stays
 * an upper bound for what users run. Until bare-os exposes that counter the
 * run stops here, before any load, rather than fit a counter known to undercount.
 */
function selectMemoryMeter(platform: string): MemoryMeter {
  if (!platform.startsWith('win32')) {
    return { counter: 'rss', read: () => positive(os.memoryUsage().rss) }
  }
  const usage = os.memoryUsage() as { rss: number; committed?: number }
  if (typeof usage.committed !== 'number') {
    throw new Error(
      'win32: bare-os memoryUsage() exposes only rss, which on Windows is the working set — the pages the OS currently keeps resident, not what the engine allocated — so no delta read from it can be an upper bound. Calibration here needs the commit charge (PROCESS_MEMORY_COUNTERS_EX.PrivateUsage) exposed as memoryUsage().committed; see METHODOLOGY.md, "Windows".'
    )
  }
  return {
    counter: 'committed',
    loadMode: 'none',
    read: () => positive((os.memoryUsage() as { committed?: number }).committed)
  }
}

function createSampler(meter: MemoryMeter) {
  const samples: number[] = []
  let timer: ReturnType<typeof setTimeout> | null = null
  let running = false

  function tick() {
    if (!running) return
    const value = meter.read()
    if (value > 0) samples.push(value)
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
      const value = meter.read()
      if (value > 0) samples.push(value)
      return samples.length > 0 ? Math.max(...samples) : 0
    }
  }
}

function settle() {
  return new Promise((resolve) => setTimeout(resolve, SETTLE_MS))
}

// Registry downloads can stall without erroring; bound each load so a stall
// fails in minutes instead of consuming the whole job timeout.
const LOAD_TIMEOUT_MS = 30 * 60 * 1000

function withLoadTimeout<T>(promise: Promise<T>, label: string) {
  let timer: ReturnType<typeof setTimeout>
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(
        new Error(
          `${label} did not finish within ${LOAD_TIMEOUT_MS / 60000} minutes; a registry download has likely stalled. Check the registry's reachability from this host.`
        )
      )
    }, LOAD_TIMEOUT_MS)
    if (timer && typeof timer.unref === 'function') timer.unref()
  })
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer))
}

/**
 * Best-effort label for the backend in play, from the drivers the resource
 * collector reports. Recorded with the coefficients because the buffers they
 * measure are allocated by the backend, while the fixture is keyed by platform.
 *
 * Ordered by what llama.cpp prefers, so the label matches the likely choice
 * rather than whichever driver happens to be listed first.
 */
function detectBackend(gpuList: readonly Record<string, unknown>[]) {
  for (const gpu of gpuList) {
    const drivers = (gpu.drivers ?? {}) as Record<
      string,
      { status: string; value?: unknown } | undefined
    >
    for (const name of ['metal', 'cuda', 'rocm', 'vulkan', 'levelZero', 'opencl']) {
      if (drivers[name]?.status === 'supported' && drivers[name].value) return name
    }
  }
  return 'cpu'
}

function gpuName(gpuList: readonly Record<string, unknown>[]) {
  for (const gpu of gpuList) {
    const name = gpu.name as { status: string; value?: string } | undefined
    if (name?.status === 'supported' && name.value) return name.value
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

/**
 * Platforms where a reported GPU means discrete device memory. RSS cannot
 * observe VRAM, so calibration there loads with `gpu_layers: 0` and describes
 * CPU-resident execution — the case where system RAM is the binding
 * constraint. Apple silicon and mobile are unified memory and keep the GPU.
 */
function forcesCpu(platform: string) {
  return platform.startsWith('linux') || platform.startsWith('win32') || platform === 'darwin-x64'
}

async function measure(
  name: string,
  contextTokens: number,
  cpuForced: boolean,
  meter: MemoryMeter
): Promise<Measurement> {
  const model = (catalog as Record<string, { sha256Checksum: string } | undefined>)[name]
  if (!model) throw new Error(`unknown catalog constant: ${name}`)

  const profile = MODEL_RESOURCE_PROFILES[model.sha256Checksum]
  if (!profile?.ggufFacts) throw new Error(`no GGUF facts for ${name}`)

  await settle()
  const before = meter.read()

  const modelId = await withLoadTimeout(
    loadModel({
      modelSrc: model,
      modelConfig: {
        ctx_size: contextTokens,
        ...(cpuForced && { gpu_layers: 0 }),
        ...(meter.loadMode && { load_mode: meter.loadMode })
      }
    }),
    `loading ${name}`
  )

  await settle()
  const afterLoad = meter.read()

  const sampler = createSampler(meter)
  sampler.start()
  const result = completion({
    modelId,
    history: [{ role: 'user', content: 'Summarize the history of cartography.' }],
    stream: false,
    params: { maxTokens: 128 }
  })
  await result.response
  const peak = sampler.stop()

  await unloadModel({ modelId })
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
  const json = JSON.stringify(calibration, null, 2)
    .replace(/"([a-zA-Z]+)":/g, '$1:')
    .replace(/"/g, "'")
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
  const platform = `${os.platform()}-${os.arch()}`
  console.log(`calibrating ${platform}`)

  const meter = selectMemoryMeter(platform)
  console.log(
    `counter: ${meter.counter}${meter.loadMode ? ` (weights loaded with load_mode '${meter.loadMode}')` : ''}`
  )

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
  const cpuForced = forcesCpu(platform)
  // What the loads will actually allocate: with `gpu_layers: 0` the engine
  // stays CPU-resident regardless of the hardware present.
  const hasGpu = gpuList.length > 0 && !cpuForced
  const backend = cpuForced ? 'cpu' : detectBackend(gpuList)
  const device = gpuName(gpuList)
  console.log(
    `backend: ${backend}${device ? ` (${device})` : ''}${cpuForced ? ' — GPU offload disabled for calibration' : ''}`
  )

  const mib = (n: number) => (n / 1024 / 1024).toFixed(0)
  const elementWidths = new Set<number>()
  const measurements: FitPoint[] = []
  for (const name of FIT_MODELS) {
    for (const contextTokens of CONTEXTS) {
      for (let repeat = 0; repeat < REPEATS; repeat++) {
        const measurement = await measure(name, contextTokens, cpuForced, meter)
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
    console.log(
      `\nthe ${meter.counter} counter observed ${(observation.ratio * 100).toFixed(0)}% of the KV cache the engine allocated between the two contexts (floor ${KV_OBSERVATION_FLOOR * 100}%): it reports residency, not allocation, so nothing fitted on it is an upper bound. No fixture written.`
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
    ...(meter.counter !== 'rss' && {
      notes: [
        `persistent deltas read the process commit charge (${meter.counter}) with weights loaded via load_mode '${meter.loadMode}', so they were anonymous memory the counter sees; the default mmap load keeps at most the artifact size resident, so weightUpperCoeff remains an upper bound for it`
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
    const heldOut = await measure(HELD_OUT_MODEL, CONTEXTS[1]!, cpuForced, meter)
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
    const target = path.join(
      os.cwd(),
      'src',
      'resources',
      'model-fit',
      'calibration',
      `${platform}.ts`
    )
    fs.writeFileSync(target, fixtureSource(platform, calibration))
    console.log(`\nwrote ${target}`)
    console.log('remember to add the platform to calibration/index.ts and run prettier')
  } else {
    console.log('\nre-run with --write to update the fixture')
  }

  // Non-zero so the CI job cannot rot green on a failed gate.
  if (!holds) Bare.exit(1)
}

main().catch((error) => {
  console.error('calibration failed:', error)
  Bare.exit(1)
})
