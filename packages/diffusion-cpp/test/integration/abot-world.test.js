// ABot-World integration test (first increment).
//
// Validates, through the addon built against qvac-ext-stable-diffusion.cpp#22
// (via the temporary vcpkg overlay port), that:
//   1. the ABot-World model set loads natively via the addon, and
//   2. batch video generation is correctly REJECTED with the documented
//      "interactive session not implemented yet" error — because ABot is a
//      causal/interactive model, not a one-shot generator.
//
// When the causal walk core lands in the engine (a follow-up sd.cpp PR + addon
// API), this test is replaced by a real "walk" assertion (start scene -> stream
// blocks with per-block actions -> validate the produced video).
//
// Model provisioning: set ABOT_MODELS_DIR to a dir populated by
// scripts/download-model-abot.sh (pulls the GGUFs from corp S3). The test skips
// when the models or a GPU are absent, so it is safe on any runner.
const fs = require('bare-fs')
const path = require('bare-path')
const os = require('bare-os')
const proc = require('bare-process')
const test = require('brittle')

const VideoStableDiffusion = require('@qvac/diffusion-cpp/video')
const { setupJsLogger } = require('./utils')

const noGpu = String(proc.env.NO_GPU || '').toLowerCase() === 'true'
const modelsDir = proc.env.ABOT_MODELS_DIR || ''
const dit = modelsDir && path.join(modelsDir, 'abot-world-0-5b-lf-dit-q8_0.gguf')
const vae = modelsDir && path.join(modelsDir, 'wan2.2_vae_f16.gguf')
const t5 = modelsDir && path.join(modelsDir, 'umt5_xxl_fp16.safetensors')

const haveModels = !!modelsDir && [dit, vae, t5].every((p) => {
  try { return fs.existsSync(p) } catch { return false }
})
const skip = noGpu || os.platform() === 'darwin' || !haveModels

console.log('[ABot-World] platform:', os.platform(), 'NO_GPU:', noGpu,
  'models:', haveModels, '→ skip:', skip)

test('ABot-World: model set loads; batch generation is guarded', { skip }, async (t) => {
  setupJsLogger()
  const world = new VideoStableDiffusion({
    files: { model: dit, vae, t5Xxl: t5 },
    config: { device: 'gpu', offload_to_cpu: true, vae_on_cpu: true },
    logger: console
  })

  await t.execution(world.load(), 'ABot DiT + Wan2.2 VAE + UMT5 load via the addon')

  // Interactive causal model → batch txt2vid must be rejected, not silently run.
  await t.exception(
    world.run({ mode: 'txt2vid', prompt: 'a coastal street', width: 832, height: 480, video_frames: 9 }),
    /ABot-World|not supported by batch|interactive session/i,
    'batch generation rejected with the documented ABot message'
  )

  await world.unload()
})
