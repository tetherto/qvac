'use strict'

// ABot-World integration test (first increment).
//
// Validates, through the addon built against qvac-ext-stable-diffusion.cpp#22
// (via the temporary vcpkg overlay port), that the ABot-World model set loads
// natively and that batch video generation is rejected with the documented
// "interactive session not implemented yet" error — ABot is a causal/interactive
// model, not a one-shot generator. Replaced by a real walk assertion when the
// causal core lands.
//
// Set ABOT_MODELS_DIR to a dir populated by scripts/download-model-abot.sh
// (pulls the GGUFs from corp S3). Skips when the models or a GPU are absent.

const path = require('bare-path')
const os = require('bare-os')
const proc = require('bare-process')
const fs = require('bare-fs')
const test = require('brittle')

const VideoStableDiffusion = require('../../video.js')
const { setupJsLogger } = require('./utils.js')

const dir = proc.env.ABOT_MODELS_DIR || ''
const files = {
  model: dir && path.join(dir, 'abot-world-0-5b-lf-dit-q8_0.gguf'),
  vae: dir && path.join(dir, 'wan2.2_vae_f16.gguf'),
  t5Xxl: dir && path.join(dir, 'umt5_xxl_fp16.safetensors')
}

const noGpu = proc.env && proc.env.NO_GPU === 'true'
const have = !!dir && Object.values(files).every((p) => fs.existsSync(p))
const skip = noGpu || os.platform() === 'darwin' || !have

console.log('[ABot-World] skip:', skip, 'have models:', have)

test('ABot-World: model set loads; batch generation is guarded', { skip }, async (t) => {
  setupJsLogger()

  const world = new VideoStableDiffusion({
    files,
    config: {
      device: 'gpu',
      offload_to_cpu: true,
      vae_on_cpu: true
    },
    logger: console
  })

  await t.execution(world.load(), 'ABot DiT + Wan2.2 VAE + UMT5 load via the addon')

  const generation = world.run({
    mode: 'txt2vid',
    prompt: 'a coastal street',
    width: 832,
    height: 480,
    video_frames: 9
  })

  await t.exception(
    generation,
    /ABot-World|not supported by batch|interactive session/i,
    'batch generation rejected with the documented ABot message'
  )

  await world.unload().catch(() => {})
})
