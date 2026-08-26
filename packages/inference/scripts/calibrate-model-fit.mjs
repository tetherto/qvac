// Calibration harness for assessModelFit (QVAC-23889).
//
// Loads representative catalog models, measures resident and peak memory around
// real operations, and derives the coefficients in
// `src/resources/model-fit/calibration/<platform>.ts`.
//
// Run from the package root, on the platform being calibrated:
//
//   npm run build
//   bare scripts/calibrate-model-fit.mjs            # measure and print
//   bare scripts/calibrate-model-fit.mjs --write    # also rewrite the fixture
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
import { kvElementBytes } from '../dist/resources/model-fit/estimators/llm.js'
import { llmPlugin } from '../dist/plugins/builtin/llamacpp-completion/plugin.js'

const SAMPLE_INTERVAL_MS = 25
const SETTLE_MS = 250

// Two contexts per model so fixed overhead and the per-token compute buffer can
// be separated; a single point cannot tell them apart.
const CONTEXTS = [512, 8192]

// Small, medium, large — plus one held out of the fit entirely, used only to
// check that the derived upper bound actually holds.
const FIT_MODELS = ['QWEN3_600M_INST_Q4', 'LLAMA_3_2_1B_INST_Q4_0', 'QWEN3_4B_INST_Q4_K_M']
const HELD_OUT_MODEL = 'QWEN3_8B_INST_Q4_K_M'

function rssBytes() {
  const usage = os.memoryUsage()
  return usage && usage.rss > 0 ? usage.rss : 0
}

function createSampler() {
  const samples = []
  let timer = null
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
function detectBackend(gpuList) {
  for (const gpu of gpuList) {
    const drivers = gpu.drivers ?? {}
    for (const name of ['metal', 'cuda', 'rocm', 'vulkan', 'levelZero', 'opencl']) {
      if (drivers[name]?.status === 'supported' && drivers[name].value) return name
    }
  }
  return 'cpu'
}

function gpuName(gpuList) {
  for (const gpu of gpuList) {
    if (gpu.name?.status === 'supported' && gpu.name.value) return gpu.name.value
  }
  return undefined
}

/**
 * KV-cache bytes for one model at one context, using the same accounting the
 * estimator uses. Kept in sync deliberately: the harness measures the residual
 * left over *after* the KV cache is accounted for, so the coefficients it
 * derives describe everything else.
 */
function kvBytes(facts, contextTokens, bytesPerElement) {
  const tokens = Math.min(contextTokens, facts.contextLength)

  if (facts.kvLayerClasses?.length) {
    let total = 0
    for (const layerClass of facts.kvLayerClasses) {
      const classTokens =
        layerClass.windowed && facts.slidingWindow ? Math.min(tokens, facts.slidingWindow) : tokens
      total +=
        layerClass.count *
        layerClass.headCountKv *
        (layerClass.keyLength + layerClass.valueLength) *
        classTokens *
        bytesPerElement
    }
    return total
  }

  const perBlockPerToken = facts.headCountKv * (facts.keyLength + facts.valueLength)
  const blocks = facts.fullAttentionInterval
    ? Math.ceil(facts.blockCount / facts.fullAttentionInterval)
    : facts.blockCount
  return blocks * perBlockPerToken * tokens * bytesPerElement
}

async function measure(name, contextTokens) {
  const model = catalog[name]
  if (!model) throw new Error(`unknown catalog constant: ${name}`)

  const profile = MODEL_RESOURCE_PROFILES[model.sha256Checksum]
  if (!profile?.ggufFacts) throw new Error(`no GGUF facts for ${name}`)

  await settle()
  const rssBefore = rssBytes()

  const modelId = await loadModel({
    modelSrc: model,
    modelConfig: { 'ctx-size': contextTokens }
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

/**
 * Least-squares fit of `residual = fixed + perToken × context`, where the
 * residual is measured working memory minus the KV cache the estimator would
 * already have accounted for.
 */
function fitResiduals(points) {
  const n = points.length
  const sumX = points.reduce((total, p) => total + p.contextTokens, 0)
  const sumY = points.reduce((total, p) => total + p.residual, 0)
  const sumXY = points.reduce((total, p) => total + p.contextTokens * p.residual, 0)
  const sumXX = points.reduce((total, p) => total + p.contextTokens ** 2, 0)

  const denominator = n * sumXX - sumX ** 2
  if (denominator === 0) return { fixed: sumY / n, perToken: 0 }

  const perToken = (n * sumXY - sumX * sumY) / denominator
  const fixed = (sumY - perToken * sumX) / n
  return { fixed: Math.max(0, fixed), perToken: Math.max(0, perToken) }
}

function fixtureSource(platform, calibration) {
  const json = JSON.stringify(calibration, null, 2)
    .replace(/"([a-zA-Z]+)":/g, '$1:')
    .replace(/"/g, "'")
  return `import type { PlatformCalibration } from '@/resources/model-fit/types'

/**
 * ${platform} coefficients.
 *
 * Generated by \`scripts/calibrate-model-fit.mjs\`; see \`METHODOLOGY.md\` next
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

  // The residual is what is left after the KV cache is accounted for, so the
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

  const elementWidths = new Set()
  const measurements = []
  for (const name of FIT_MODELS) {
    for (const contextTokens of CONTEXTS) {
      const measurement = await measure(name, contextTokens)
      // `.lower` is the width a GPU backend defaults to (q8_0), and equals f16
      // when no GPU is reported — what the engine allocates in each case, not an
      // optimistic bound borrowed from the estimator's range.
      const bytesPerElement = kvElementBytes(measurement.facts, hasGpu).bytes.lower
      elementWidths.add(bytesPerElement)
      const kv = kvBytes(measurement.facts, contextTokens, bytesPerElement)
      // Deliberately unclamped. A negative residual is the signature of
      // subtracting a cache the engine never allocated, and clamping it here
      // would hide exactly the failure worth catching.
      measurements.push({ ...measurement, kv, residual: measurement.workingBytes - kv })
      const mib = (n) => (n / 1024 / 1024).toFixed(0)
      console.log(
        `  ${name} @ ${contextTokens}: persistent ${mib(measurement.persistentBytes)} MiB, working ${mib(measurement.workingBytes)} MiB, kv ${mib(kv)} MiB`
      )
    }
  }

  if (elementWidths.size > 1) {
    console.log(
      `\nwarning: the fit mixes KV element widths (${[...elementWidths].join(', ')} bytes), so the residuals do not describe a single cache type`
    )
  }

  // Fail loudly rather than fitting nonsense: `fitResiduals` floors its output
  // at zero, so a bad subtraction would otherwise emit a plausible-looking
  // `{ lower: 0, upper: 0 }` instead of an error.
  const negative = measurements.filter((m) => m.residual < 0)
  if (negative.length > 0) {
    console.log(
      `\n${negative.length} of ${measurements.length} residuals are negative: the KV cache being subtracted is larger than the working memory measured. The assumed cache type does not match what the engine allocated, so the fit would be meaningless. No fixture written.`
    )
    return
  }

  const weightRatios = measurements.map((m) => m.persistentBytes / m.artifactBytes)
  const fit = fitResiduals(measurements)

  // The upper bound has to cover the worst point observed, not the average, or
  // the held-out check below is meaningless.
  const worstResidual = Math.max(...measurements.map((m) => m.residual))

  const calibration = {
    weightUpperCoeff: Number(Math.max(1, ...weightRatios).toFixed(3)),
    fixedOverheadBytes: {
      lower: Math.round(fit.fixed * 0.8),
      upper: Math.round(Math.max(fit.fixed, worstResidual) * 1.2)
    },
    computeBufferBytesPerToken: {
      lower: Math.round(fit.perToken * 0.8),
      upper: Math.round(fit.perToken * 1.2)
    },
    // Audio coefficients need a whisper pass; left at zero until that runs.
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

  const heldOut = await measure(HELD_OUT_MODEL, CONTEXTS[1])
  // Predict with the width this run actually allocated, not the estimator's f16
  // upper end. Using f16 here on a q8_0 backend would pad the prediction by the
  // whole cache-type spread and let weak coefficients through the gate; the
  // point is to test the fit, not the conservatism of the range.
  const predictedUpper =
    heldOut.artifactBytes * calibration.weightUpperCoeff +
    calibration.fixedOverheadBytes.upper +
    calibration.computeBufferBytesPerToken.upper * CONTEXTS[1] +
    kvBytes(heldOut.facts, CONTEXTS[1], kvElementBytes(heldOut.facts, hasGpu).bytes.lower)
  const measuredTotal = heldOut.persistentBytes + heldOut.workingBytes
  const holds = measuredTotal <= predictedUpper

  console.log(
    `\nheld-out ${HELD_OUT_MODEL}: measured ${(measuredTotal / 2 ** 30).toFixed(2)} GiB vs predicted upper ${(predictedUpper / 2 ** 30).toFixed(2)} GiB — ${holds ? 'PASS' : 'FAIL'}`
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
