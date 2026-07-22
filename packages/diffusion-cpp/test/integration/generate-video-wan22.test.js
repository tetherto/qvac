'use strict'

// Opt-in Wan 2.2 smoke tests.
//
// The Turbo model is intentionally not downloaded by ordinary integration
// runs: it is ~16.4 GB including its shared UMT5 encoder and VAE. Enable it
// on a Linux/CUDA runner:
//
//   WAN22_RUN_SMOKE=true WAN22_MODELS_DIR=/path/to/models \
//     bare test/integration/generate-video-wan22.test.js --exit

const fs = require('bare-fs')
const os = require('bare-os')
const path = require('bare-path')
const proc = require('bare-process')
const test = require('brittle')
const VideoStableDiffusion = require('@qvac/diffusion-cpp/video')
const { verifyLocalModelPath } = require('./utils')

const enabled = proc.env && proc.env.WAN22_RUN_SMOKE === 'true'
const modelsDir = proc.env && proc.env.WAN22_MODELS_DIR
const skip = !enabled || os.platform() === 'darwin'

const FILES = [
  'Wan2_2-TI2V-5B-Turbo-Q5_K_S.gguf',
  'wan2.2_vae.safetensors',
  'umt5_xxl_fp16.safetensors'
]

function isAvi(buf) {
  return (
    buf instanceof Uint8Array &&
    buf.length > 64 &&
    String.fromCharCode(...buf.subarray(0, 4)) === 'RIFF' &&
    String.fromCharCode(...buf.subarray(8, 12)) === 'AVI '
  )
}

test(
  'Wan 2.2 TI2V-5B Turbo Q5_K_S — smoke (txt2vid) generates a valid AVI',
  { timeout: 900000, skip },
  async (t) => {
    if (!modelsDir) {
      throw new Error('WAN22_MODELS_DIR is required when WAN22_RUN_SMOKE=true')
    }

    const resolved = {}
    for (const name of FILES) {
      const filePath = path.join(modelsDir, name)
      t.ok(fs.existsSync(filePath), `model file is present: ${name}`)
      await verifyLocalModelPath({ modelName: name, filePath })
      resolved[name] = filePath
    }

    const model = new VideoStableDiffusion({
      files: {
        model: resolved['Wan2_2-TI2V-5B-Turbo-Q5_K_S.gguf'],
        vae: resolved['wan2.2_vae.safetensors'],
        t5Xxl: resolved['umt5_xxl_fp16.safetensors']
      },
      config: {
        threads: 4,
        device: 'gpu',
        diffusion_fa: true,
        offload_to_cpu: true,
        vae_tiling: true
      },
      logger: console,
      opts: { stats: true }
    })

    let avi = null
    try {
      await model.load()
      const response = await model.run({
        mode: 'txt2vid',
        prompt: 'a red fox running through snow at dusk',
        width: 416,
        height: 256,
        video_frames: 5,
        fps: 16,
        steps: 4,
        cfg_scale: 1.0,
        flow_shift: 5.0,
        seed: 7
      })
      await response
        .onUpdate((data) => {
          if (data instanceof Uint8Array) avi = data
        })
        .await()

      t.ok(isAvi(avi), 'received a RIFF/AVI output buffer')
      t.ok(response.stats && response.stats.videoFrames === 5, 'stats report five output frames')
    } finally {
      await model.unload()
    }
  }
)
