// Calibration harness for assessModelFit (QVAC-23889).
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
// mean and how the held-out check works.

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
import { fitResidentMemory } from '../dist/resources/model-fit/calibration/fit.js'
import { llmPlugin } from '../dist/plugins/builtin/llamacpp-completion/plugin.js'
import type { GgufFacts } from '../dist/schemas/model-resource-profile.js'
import type { PlatformCalibration } from '../dist/resources/model-fit/types.js'

declare const Bare: { argv: string[]; exit(code?: number): void }

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

async function measure(name: string, contextTokens: number): Promise<Measurement> {
  const model = (catalog as Record<string, { sha256Checksum: string } | undefined>)[name]
  if (!model) throw new Error(`unknown catalog constant: ${name}`)

  const profile = MODEL_RESOURCE_PROFILES[model.sha256Checksum]
  if (!profile?.ggufFacts) throw new Error(`no GGUF facts for ${name}`)

  await settle()
  const rssBefore = rssBytes()

  const modelId = await loadModel({
    modelSrc: model,
    modelConfig: { ctx_size: contextTokens }
  })

  await settle()
  const rssAfterLoad = rssBytes()

  const sampler = createSampler()
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
    persistentBytes: Math.max(0, rssAfterLoad - rssBefore),
    workingBytes: Math.max(0, peak - rssAfterLoad)
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
  const hasGpu = gpuList.length > 0
  const backend = detectBackend(gpuList)
  const device = gpuName(gpuList)
  console.log(`backend: ${backend}${device ? ` (${device})` : ''}`)

  const mib = (n: number) => (n / 1024 / 1024).toFixed(0)
  const elementWidths = new Set<number>()
  const measurements: FitPoint[] = []
  for (const name of FIT_MODELS) {
    for (const contextTokens of CONTEXTS) {
      for (let repeat = 0; repeat < REPEATS; repeat++) {
        const measurement = await measure(name, contextTokens)
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

  // Fail loudly rather than fitting nonsense: a load that measured smaller
  // than the KV cache it supposedly allocated means the assumed cache type
  // does not match what the engine did.
  const negative = measurements.filter((m) => m.persistentBytes - m.kvBytes < 0)
  if (negative.length > 0) {
    console.log(
      `\n${negative.length} of ${measurements.length} points measured less persistent memory than the KV cache being subtracted. The assumed cache type does not match what the engine allocated, so the fit would be meaningless. No fixture written.`
    )
    return
  }

  const fit = fitResidentMemory(measurements)
  if (!fit) {
    console.log(
      '\nthe measurement design cannot separate the weight ratio, fixed overhead and per-token slope (degenerate fit). No fixture written.'
    )
    return
  }
  console.log(
    `\nfit: weightRatio ${fit.weightRatio.toFixed(3)}, fixed ${mib(fit.fixedBytes)} MiB, perToken ${fit.perTokenBytes.toFixed(0)} B, worst excess ${mib(fit.worstExcessBytes)} MiB`
  )

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
    const heldOut = await measure(HELD_OUT_MODEL, CONTEXTS[1]!)
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

  if (!write) {
    console.log('\nre-run with --write to update the fixture')
    return
  }

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
}

main().catch((error) => {
  console.error('calibration failed:', error)
  Bare.exit(1)
})
