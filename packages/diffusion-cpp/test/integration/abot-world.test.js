'use strict'

// ABot-World integration tests.
//
// Two lanes, both through the addon built against
// qvac-ext-stable-diffusion.cpp#22 (temporary vcpkg overlay port):
//
//   1. Guard lane — the ABot model set loads natively and batch video
//      generation is rejected: ABot is a causal/interactive model, not a
//      one-shot generator.
//   2. Walk lane — the real thing: an interactive walk session
//      (@qvac/diffusion-cpp/world) steps through the fixed scene under
//      keyboard actions and streams decoded PNG frames.
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
//   - The walk lane additionally needs the scene pack (scene.safetensors)
//     and taew2_2_f16.gguf; if the scene pack is not present after
//     provisioning (not uploaded yet), the walk lane passes as a no-op with
//     an explanatory message instead of failing the suite.
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
const WorldStableDiffusion = require('../../world.js')
const { readImageDimensions } = require('../../addon.js')
const { ensureModelPath, setupJsLogger } = require('./utils.js')

const S3_PREFIX = 's3://tether-ai-dev/qvac_models_compiled/ABot-World-0-5B-LF/2026-07-17'
const DIT_NAME = 'abot-world-0-5b-lf-dit-q8_0.gguf'
const VAE_NAME = 'wan2.2_vae_f16.gguf'
const TAEHV_NAME = 'taew2_2_f16.gguf'
const SCENE_NAME = 'scene.safetensors'
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
  for (const name of [SUMS_NAME, DIT_NAME, VAE_NAME, TAEHV_NAME]) {
    const dest = path.join(dir, name)
    if (name !== SUMS_NAME && fs.existsSync(dest)) continue
    await run('aws', ['s3', 'cp', `${S3_PREFIX}/${name}`, dest])
  }
  // The scene pack and the umT5 encoder GGUFs ship alongside the other
  // GGUFs in newer uploads of the model set; tolerate their absence (the
  // walk lane no-ops without the scene, and the world-generation lane falls
  // back to the manifest safetensors without the encoder).
  for (const name of [SCENE_NAME, 'umt5-xxl-enc-q8_0.gguf']) {
    const dest = path.join(dir, name)
    if (!fs.existsSync(dest)) {
      await run('aws', ['s3', 'cp', `${S3_PREFIX}/${name}`, dest]).catch(() => {})
    }
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

test(
  'ABot-World: interactive walk session steps through the fixed scene',
  { skip, timeout: 2_400_000 },
  async (t) => {
    setupJsLogger()

    const dir = overrideDir || path.resolve(__dirname, '../model/abot')
    if (!overrideDir) {
      await provisionFromS3(dir)
    }

    const scenePath = path.join(dir, SCENE_NAME)
    const taehvPath = path.join(dir, TAEHV_NAME)
    if (!fs.existsSync(scenePath) || !fs.existsSync(taehvPath)) {
      t.pass(
        'walk lane skipped: scene pack / taehv not provisioned yet ' +
          `(need ${SCENE_NAME} + ${TAEHV_NAME} in ${dir})`
      )
      return
    }

    const world = new WorldStableDiffusion({
      files: {
        model: path.join(dir, DIT_NAME),
        taehv: taehvPath,
        scene: scenePath
      },
      config: { seed: 42 },
      logger: console,
      opts: { stats: true }
    })

    await t.execution(world.load(), 'walk session loads (DiT + taehv + scene pack)')

    // Two blocks: idle, then walk forward (W). The first stateless-decoded
    // block yields 4*3-3 = 9 px frames; subsequent blocks yield 4*3 = 12.
    const blocks = []
    for (const keys of [{}, { W: true }]) {
      const frames = []
      let progress = 0
      const response = await world.step(keys)
      await response
        .onUpdate((data) => {
          if (data instanceof Uint8Array) frames.push(data)
          else if (typeof data === 'string') progress++
        })
        .await()
      blocks.push(frames)
      t.ok(progress >= 1, `block ${blocks.length - 1}: progress JSON received`)
    }

    t.is(blocks[0].length, 9, 'first block streams 9 PNG frames (decoder warmup)')
    t.is(blocks[1].length, 12, 'second block streams 12 PNG frames')

    for (let b = 0; b < blocks.length; b++) {
      const allCorrect = blocks[b].every((frame) => {
        const dims = readImageDimensions(frame)
        return dims && dims.width === 832 && dims.height === 480
      })
      t.ok(allCorrect, `block ${b}: every frame is an 832x480 PNG`)
    }

    // The walk must actually move: last frame of the W block differs from the
    // last frame of the idle block.
    const a = blocks[0][blocks[0].length - 1]
    const b = blocks[1][blocks[1].length - 1]
    t.ok(
      a.length !== b.length || !a.every((v, i) => v === b[i]),
      'walking forward produces different frames than idling'
    )

    await world.unload().catch(() => {})
  }
)

test(
  'ABot-World: full world generation - native scene creation + KV-cache walk',
  { skip, timeout: 2_400_000 },
  async (t) => {
    setupJsLogger()

    const dir = overrideDir || path.resolve(__dirname, '../model/abot')
    if (!overrideDir) {
      await provisionFromS3(dir)
    }

    const taehvPath = path.join(dir, TAEHV_NAME)
    const vaePath = path.join(dir, VAE_NAME)
    if (!fs.existsSync(taehvPath) || !fs.existsSync(vaePath)) {
      t.pass(
        'world-generation lane skipped: taew2_2 / Wan2.2 VAE not provisioned ' +
          `(need ${TAEHV_NAME} + ${VAE_NAME} in ${dir})`
      )
      return
    }

    // Prompt encoder resolution: prefer the model set's own umT5 GGUFs when
    // provisioned (S3 / ABOT_MODELS_DIR; Q8_0 is the validated deployment
    // quant), else fall back to the pinned-manifest safetensors the Wan tests
    // use. All three forms are gated against the golden PyTorch extraction
    // (prompt_embeds cosine 0.9973 F16 / 0.9969 Q8 CUDA, latents 0.9987).
    let t5Xxl = ''
    for (const name of ['umt5-xxl-enc-q8_0.gguf', 'umt5-xxl-enc-f16.gguf']) {
      const candidate = path.join(dir, name)
      if (fs.existsSync(candidate)) {
        t5Xxl = candidate
        break
      }
    }
    if (!t5Xxl) {
      t5Xxl = await ensureModelPath({ modelName: 'umt5_xxl_fp16.safetensors' })
    }

    const image = fs.readFileSync(
      path.resolve(__dirname, '../../assets/claude-shannon-resized.jpg')
    )
    const scenePath = path.join(dir, 'scene-native-e2e.safetensors')
    if (fs.existsSync(scenePath)) fs.unlinkSync(scenePath)

    const world = new WorldStableDiffusion({
      files: { model: path.join(dir, DIT_NAME), taehv: taehvPath, scene: scenePath },
      // kvCache exercises the params-plumbed KV path end to end; the engine
      // cross-validates it against localAttnSize and fails fast on a window
      // the compiled KV ring cannot hold.
      config: { seed: 42, kvCache: true },
      logger: console,
      opts: { stats: true }
    })

    // 1. Scene pack created natively (umT5 prompt encode + Wan2.2 VAE
    //    first-frame encode). Standalone: runs before load().
    const creation = await world.createScene({
      prompt:
        '| unknown | A realistic indoor scene with a person at a desk, ' +
        'natural lighting, detailed textures, stable forward motion.',
      image,
      t5: t5Xxl,
      vae: vaePath,
      output: scenePath,
      width: 832,
      height: 480
    })
    let sceneMsg = ''
    await creation
      .onUpdate((data) => {
        if (typeof data === 'string') sceneMsg = data
      })
      .await()
    t.ok(fs.existsSync(scenePath), 'scene pack written by native scene creation')
    t.ok(/"scene"/.test(sceneMsg), 'scene-creation completion JSON received')

    // 2. Walk the newly created world with the KV cache on.
    await t.execution(world.load(), 'walk session loads the natively created pack')
    const frames = []
    for (const keys of [{}, { W: true }]) {
      const response = await world.step(keys)
      await response
        .onUpdate((data) => {
          if (data instanceof Uint8Array) frames.push(data)
        })
        .await()
    }
    t.is(frames.length, 9 + 12, 'two KV-cache blocks stream 21 frames')
    t.ok(
      frames.every((frame) => {
        const dims = readImageDimensions(frame)
        return dims && dims.width === 832 && dims.height === 480
      }),
      'every frame is an 832x480 PNG'
    )

    await world.unload().catch(() => {})
  }
)
