'use strict'

// Steady-state inference benchmark for the VLA addon.
// Loads the model once per backend, then runs N inferences back-to-back
// and prints per-iteration per-stage timings. The first iteration warms
// caches; we report median + min over the remaining iterations.
//
// Usage:
//   QVAC_VLA_MODEL=/path/to/smolvla.gguf bare test/bench.js [iters] [backends]
//   defaults: iters=5, backends="auto,cpu"

const fs = require('bare-fs')
const path = require('bare-path')
const process = require('bare-process')
const { VlaModel, preprocessImage, padState } = require('..')

const argv = process.argv.slice(2)
const iters = parseInt(argv[0] || '5', 10)
const backends = (argv[1] || 'auto,cpu').split(',').map((s) => s.trim()).filter(Boolean)

const modelPath = process.env.QVAC_VLA_MODEL
if (!modelPath || !fs.existsSync(modelPath)) {
  console.error(`bench: QVAC_VLA_MODEL must point to a valid GGUF (got "${modelPath || ''}")`)
  process.exit(1)
}

function median (xs) {
  const sorted = xs.slice().sort((a, b) => a - b)
  const n = sorted.length
  return n % 2 === 0
    ? (sorted[n / 2 - 1] + sorted[n / 2]) / 2
    : sorted[(n - 1) / 2]
}

async function runBackend (backend) {
  const model = new VlaModel({
    files: { model: [path.resolve(modelPath)] },
    opts: { stats: true }
  })
  await model.load({ backend })

  const hp = model.hparams
  const size = hp.visionImageSize
  const dummy = new Uint8Array(size * size * 3).fill(128)
  const img = preprocessImage(dummy, size, size, { size })
  const tokens = new Int32Array(hp.tokenizerMaxLength)
  const mask = new Uint8Array(hp.tokenizerMaxLength)
  tokens[0] = 1
  mask[0] = 1
  const state = padState([0, 0, 0, 0, 0, 0], hp.maxStateDim)
  const noise = new Float32Array(hp.chunkSize * hp.maxActionDim)
  for (let i = 0; i < noise.length; i++) noise[i] = 0

  const stages = ['vision_ms', 'smollm2_compute_ms', 'smollm2_total_ms', 'ode_ms', 'total_ms']
  const results = stages.reduce((acc, k) => { acc[k] = []; return acc }, {})

  for (let i = 0; i < iters; i++) {
    const response = await model.run({ images: [img, img], imgWidth: size, imgHeight: size, state, tokens, mask, noise })
    const { stats } = await response.await()
    for (const k of stages) results[k].push(stats[k])
    console.log(
      `[BENCH ${backend} iter=${i + 1}/${iters}]` +
      ` vision=${stats.vision_ms.toFixed(0)}` +
      ` smollm2_compute=${stats.smollm2_compute_ms.toFixed(0)}` +
      ` smollm2_total=${stats.smollm2_total_ms.toFixed(0)}` +
      ` ode=${stats.ode_ms.toFixed(0)}` +
      ` total=${stats.total_ms.toFixed(0)}`
    )
  }

  await model.unload().catch(() => {})

  // Drop the warm-up iteration when reporting steady-state numbers.
  const warm = (xs) => xs.slice(Math.min(1, xs.length - 1))
  const summary = {}
  for (const k of stages) {
    const xs = warm(results[k])
    summary[k] = { min: Math.min(...xs), med: median(xs), max: Math.max(...xs) }
  }
  console.log(`[SUMMARY ${backend}] (warm, n=${Math.max(1, iters - 1)})`)
  for (const k of stages) {
    console.log(`  ${k}: min=${summary[k].min.toFixed(0)} med=${summary[k].med.toFixed(0)} max=${summary[k].max.toFixed(0)}`)
  }
  return { backend, results, summary }
}

;(async () => {
  for (const b of backends) {
    try {
      await runBackend(b)
    } catch (err) {
      console.error(`bench: ${b} failed — ${err && err.stack || err}`)
      process.exit(2)
    }
  }
  process.exit(0)
})()
