'use strict'

// ABot-World integration test (first increment).
//
// Proves, through the addon built against qvac-ext-stable-diffusion.cpp#22
// (temporary vcpkg overlay port), that the ABot-World model set loads natively
// on the GPU runner and that batch video generation is rejected with the
// documented "interactive session not implemented yet" error — ABot is a
// causal/interactive model, not a one-shot generator. Replaced by a real walk
// assertion when the causal core lands.
//
// Model provisioning (self-contained):
//   - UMT5-XXL comes from the pinned models manifest via ensureModelPath
//     (same file the Wan tests use, so it is usually cached on the runner).
//   - The ABot GGUFs live on corp S3 (private bucket); when AWS credentials
//     are present in the environment (the integration workflow configures
//     them via OIDC in this job) they are fetched with `aws s3 cp` and
//     verified against the SHA256SUMS published in the same S3 prefix.
//   - ABOT_MODELS_DIR overrides both (local runs, see
//     scripts/download-model-abot.sh).
//
// The S3 path is Linux-only (aws CLI + sha256sum are present on the
// qvac-ubuntu*-gpu runners); other platforms skip unless ABOT_MODELS_DIR is
// set.

const path = require('bare-path')
const os = require('bare-os')
const proc = require('bare-process')
const fs = require('bare-fs')
const test = require('brittle')

const VideoStableDiffusion = require('../../video.js')
const { ensureModelPath, setupJsLogger } = require('./utils.js')

const S3_PREFIX = 's3://tether-ai-dev/qvac_models_compiled/ABot-World-0-5B-LF/2026-07-17'
const DIT_NAME = 'abot-world-0-5b-lf-dit-q8_0.gguf'
const VAE_NAME = 'wan2.2_vae_f16.gguf'
const SUMS_NAME = 'SHA256SUMS'

const noGpu = proc.env && proc.env.NO_GPU === 'true'
const isLinux = os.platform() === 'linux'
const overrideDir = proc.env.ABOT_MODELS_DIR || ''
const haveAwsCreds = !!(proc.env.AWS_ACCESS_KEY_ID || proc.env.AWS_SESSION_TOKEN)
const canFetchS3 = isLinux && haveAwsCreds

const skip = noGpu || (!overrideDir && !canFetchS3)

console.log('[ABot-World] skip:', skip, 'override:', !!overrideDir, 'awsCreds:', haveAwsCreds)

function run(cmd, args, opts) {
  const { spawn } = require('bare-subprocess')
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: 'inherit', ...opts })
    child.on('error', reject)
    child.on('exit', (code) => {
      if (code === 0) resolve()
      else reject(new Error(`${cmd} ${args.join(' ')} exited with code ${code}`))
    })
  })
}

async function provisionFromS3(dir) {
  fs.mkdirSync(dir, { recursive: true })
  for (const name of [SUMS_NAME, DIT_NAME, VAE_NAME]) {
    const dest = path.join(dir, name)
    if (name !== SUMS_NAME && fs.existsSync(dest)) continue
    await run('aws', ['s3', 'cp', `${S3_PREFIX}/${name}`, dest])
  }
  // Verify transfer integrity against the checksums published with the set.
  await run('sha256sum', ['--check', '--ignore-missing', SUMS_NAME], { cwd: dir })
}

test(
  'ABot-World: model set loads; batch generation is guarded',
  { skip, timeout: 2_400_000 },
  async (t) => {
    setupJsLogger()

    const dir = overrideDir || path.resolve(__dirname, '../model/abot')
    if (!overrideDir) {
      await provisionFromS3(dir)
      t.pass('ABot GGUFs fetched from S3 and sha256-verified')
    }

    const t5Xxl = await ensureModelPath({ modelName: 'umt5_xxl_fp16.safetensors' })

    const world = new VideoStableDiffusion({
      files: {
        model: path.join(dir, DIT_NAME),
        vae: path.join(dir, VAE_NAME),
        t5Xxl
      },
      config: {
        device: 'gpu',
        offload_to_cpu: true,
        vae_on_cpu: true
      },
      logger: console
    })

    await t.execution(world.load(), 'ABot DiT + Wan2.2 VAE + UMT5 load via the addon')

    // run() resolves to a QvacResponse; the failure surfaces on its terminal.
    // The engine-side guard message ("ABot-World models are not supported by
    // batch generate_video()...") is logged natively; the JS-visible rejection
    // is "processVideo: generate_video() failed".
    const response = await world.run({
      mode: 'txt2vid',
      prompt: 'a coastal street',
      width: 832,
      height: 480,
      video_frames: 9
    })

    await t.exception(
      response.onUpdate(() => {}).await(),
      /generate_video\(\) failed|ABot-World|not supported by batch/i,
      'batch generation rejected (ABot is interactive-only; guard fired)'
    )

    await world.unload().catch(() => {})
  }
)
