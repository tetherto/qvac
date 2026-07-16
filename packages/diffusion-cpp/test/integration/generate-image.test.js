'use strict'

const fs = require('bare-fs')
const path = require('bare-path')
const os = require('bare-os')
const proc = require('bare-process')
const binding = require('../../binding')
const ImgStableDiffusion = require('../../index')
const { ensureModel, detectPlatform, setupJsLogger, isPng, safeTest } = require('./utils')
const { recordPerformance, PERF_RUNS, WARMUP_RUNS } = require('./_perf-helper')

const platform = detectPlatform()
const isDarwinX64 = os.platform() === 'darwin' && os.arch() === 'x64'
const isLinuxArm64 = os.platform() === 'linux' && os.arch() === 'arm64'
const isMobile = os.platform() === 'ios' || os.platform() === 'android'
const noGpu = proc.env && proc.env.NO_GPU === 'true'
const useCpu = isDarwinX64 || isLinuxArm64 || noGpu
const skip = isMobile || noGpu

const DEFAULT_MODEL = {
  name: 'stable-diffusion-v2-1-Q8_0.gguf'
}

safeTest('SD2.1 txt2img — generates a valid PNG image', { timeout: 600000, skip }, async (t) => {
  setupJsLogger(binding)

  let model = null
  try {
    const [downloadedModelName, modelDir] = await ensureModel({
      modelName: DEFAULT_MODEL.name
    })

    console.log('\n' + '='.repeat(60))
    console.log('STABLE DIFFUSION 2.1 — INTEGRATION TEST')
    console.log('='.repeat(60))
    console.log(` Platform  : ${platform}`)
    console.log(` Model     : ${downloadedModelName}`)
    console.log(` Models dir: ${modelDir}`)

    const modelPath = path.join(modelDir, downloadedModelName)
    t.ok(fs.existsSync(modelPath), 'Model file exists on disk')

    model = new ImgStableDiffusion({
      files: {
        model: path.join(modelDir, downloadedModelName)
      },
      config: {
        threads: 4,
        device: useCpu ? 'cpu' : 'gpu',
        prediction: 'v', // SD2.1 uses v-prediction
        diffusion_fa: true,
        fa: true,
        diffusion_conv_direct: true,
        vae_conv_direct: true,
        verbosity: 2
      },
      logger: console,
      opts: { stats: true }
    })

    const images = []
    const progressTicks = []
    let stats = null

    // ── Load ─────────────────────────────────────────────────────────────────
    console.log('\n=== Loading model ===')
    const tLoad = Date.now()
    await model.load()
    const loadMs = Date.now() - tLoad
    console.log(`Loaded in ${(loadMs / 1000).toFixed(1)}s`)
    t.ok(loadMs < 120000, `Model loaded within 120s (took ${(loadMs / 1000).toFixed(1)}s)`)

    // ── Generate (perf loop) ───────────────────────────────────────────────────
    const totalIterations = WARMUP_RUNS + PERF_RUNS
    for (let iteration = 0; iteration < totalIterations; iteration++) {
      const isWarmup = iteration < WARMUP_RUNS
      const runLabel = isWarmup
        ? `warmup ${iteration + 1}`
        : `run ${iteration - WARMUP_RUNS + 1}/${PERF_RUNS}`
      console.log(`\n=== Generating image (${runLabel}) ===`)
      const tGen = Date.now()
      let ttfbMs = null

      images.length = 0
      progressTicks.length = 0

      const response = await model.run({
        prompt: 'a red fox in a snowy forest, photorealistic',
        negative_prompt: 'blurry, low quality, watermark',
        steps: 10,
        width: 712,
        height: 712,
        cfg_scale: 7.5,
        seed: 42 + iteration
      })

      await response
        .onUpdate((data) => {
          if (ttfbMs === null) ttfbMs = Date.now() - tGen
          if (data instanceof Uint8Array) {
            images.push(data)
          } else if (typeof data === 'string') {
            try {
              const tick = JSON.parse(data)
              if ('step' in tick && 'total' in tick) {
                progressTicks.push(tick)
              }
            } catch (_) {}
          }
        })
        .await()

      const genMs = Date.now() - tGen
      console.log(`Generated in ${(genMs / 1000).toFixed(1)}s (TTFB: ${ttfbMs}ms)`)

      stats = response.stats

      if (!isWarmup) {
        t.comment(
          recordPerformance(
            '[SD2.1 Q8_0 txt2img 712x712] [' + (useCpu ? 'CPU' : 'GPU') + ']',
            response.stats,
            {
              scenario: 'txt2img',
              model: 'stable-diffusion-v2-1-Q8_0',
              execution_provider: useCpu ? 'cpu' : 'gpu',
              ttfbMs
            }
          )
        )
      }
    }

    // ── Assertions (on last iteration) ──────────────────────────────────────
    t.ok(progressTicks.length > 0, `Received progress ticks (got ${progressTicks.length})`)
    t.is(
      progressTicks[progressTicks.length - 1].total,
      10,
      'Final progress tick reports 10 total steps'
    )

    t.is(images.length, 1, 'Received exactly 1 image')

    const img = images[0]
    t.ok(img instanceof Uint8Array, 'Image is a Uint8Array')
    t.ok(img.length > 0, `Image is non-empty (${img.length} bytes)`)
    t.ok(isPng(img), 'Image has valid PNG magic bytes')

    // ── Runtime stats (new phase-breakdown fields) ────────────────────────────
    t.ok(stats, 'stats object is populated')
    t.ok(
      typeof stats.conditionerMs === 'number' && stats.conditionerMs > 0,
      `conditionerMs is a positive number (got ${stats.conditionerMs})`
    )
    t.ok(
      typeof stats.denoiseMs === 'number' && stats.denoiseMs > 0,
      `denoiseMs is a positive number (got ${stats.denoiseMs})`
    )
    t.ok(
      typeof stats.vaeMs === 'number' && stats.vaeMs > 0,
      `vaeMs is a positive number (got ${stats.vaeMs})`
    )
    t.ok(
      typeof stats.postProcessMs === 'number' && stats.postProcessMs >= 0,
      `postProcessMs is a non-negative number (got ${stats.postProcessMs})`
    )
    t.ok(
      typeof stats.stepsPerSecond === 'number' && stats.stepsPerSecond > 0,
      `stepsPerSecond is a positive number (got ${stats.stepsPerSecond})`
    )

    // The four phases are exhaustive: conditioner + denoise + vae + postProcess
    // spans t0..t1, which is exactly generationMs. Only int-rounding of
    // generationMs and sub-ms jitter clamps separate them, so hold a tight bound.
    const totalPhaseMs = stats.conditionerMs + stats.denoiseMs + stats.vaeMs + stats.postProcessMs
    const tolerance = Math.max(2, stats.generationMs * 0.01)
    const diff = Math.abs(totalPhaseMs - stats.generationMs)
    t.ok(
      diff <= tolerance,
      `Phase times sum to generation time: ${totalPhaseMs.toFixed(0)}ms ≈ ${stats.generationMs}ms (diff ${diff.toFixed(0)}ms, tol ${tolerance.toFixed(0)}ms)`
    )

    // ── Batch runtime stats ───────────────────────────────────────────────────
    // stable-diffusion.cpp invokes its sampler once per batch item, then
    // decodes all final latents. The phase tracker must include both sampler
    // sequences in denoiseMs rather than folding the second into vaeMs.
    images.length = 0
    const batchSteps = 2
    const batchResponse = await model.run({
      prompt: 'a red fox in a snowy forest, photorealistic',
      negative_prompt: 'blurry, low quality, watermark',
      steps: batchSteps,
      width: 512,
      height: 512,
      cfg_scale: 7.5,
      seed: 100,
      batch_count: 2
    })
    await batchResponse
      .onUpdate((data) => {
        if (data instanceof Uint8Array) images.push(data)
      })
      .await()

    const batchStats = batchResponse.stats
    t.is(images.length, 2, 'batch_count=2 returns two images')
    t.ok(
      typeof batchStats.denoiseMs === 'number' && batchStats.denoiseMs > 0,
      `batch denoiseMs is positive (got ${batchStats.denoiseMs})`
    )
    t.ok(
      typeof batchStats.stepsPerSecond === 'number' && batchStats.stepsPerSecond > 0,
      `batch stepsPerSecond is positive (got ${batchStats.stepsPerSecond})`
    )
    t.ok(
      Math.abs((batchStats.stepsPerSecond * batchStats.denoiseMs) / 1000 - batchSteps * 2) < 0.001,
      'batch throughput accounts for both sampler sequences'
    )
    const batchPhaseMs =
      batchStats.conditionerMs + batchStats.denoiseMs + batchStats.vaeMs + batchStats.postProcessMs
    const batchTolerance = Math.max(2, batchStats.generationMs * 0.01)
    t.ok(
      Math.abs(batchPhaseMs - batchStats.generationMs) <= batchTolerance,
      `batch phase times sum to generation time: ${batchPhaseMs.toFixed(0)}ms ≈ ${batchStats.generationMs}ms`
    )

    // Save output for CI artifact upload — filename encodes test origin
    // Saved to modelDir so mobile has write permission to the same path
    const outPath = path.join(modelDir, 'generate-image--sd2-txt2img-seed42.png')
    fs.writeFileSync(outPath, img)
    console.log(`\nSaved → ${outPath}`)
  } finally {
    console.log('\n=== Cleanup ===')
    if (model) await model.unload().catch(() => {})
    try {
      binding.releaseLogger()
    } catch (_) {}
    console.log('Done.')
  }
})
