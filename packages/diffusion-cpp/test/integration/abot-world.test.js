'use strict'

// ABot-World integration tests.
//
// Lanes below run through the addon built against the published
// stable-diffusion-cpp registry port (2026-07-03#7, engine PRs #22 + #27):
//
//   1. Guard lane — the ABot model set loads natively and batch video
//      generation is rejected: ABot is a causal/interactive model, not a
//      one-shot generator.
//   2. Walk lane — an interactive walk session (@qvac/diffusion-cpp/world)
//      steps through the fixed scene under keyboard actions and streams
//      decoded PNG frames (no-op until a scene pack ships in the set).
//   3. World-generation lane — the full workflow: native createScene()
//      (umT5 + Wan2.2 VAE) from a real photo, then a KV-cache walk over a
//      mixed key tape with busy-contract and motion asserts.
//   4. Variations lane — parameter coverage: small-image upscale path,
//      448x256 output, JPEG frame encoding.
//
// Model provisioning (self-contained, public):
//   - The ABot model set is published in the QVAC P2P model registry
//     (tag `abot-world`); missing files are downloaded in-process with
//     @qvac/registry-client (no credentials - the client joins the public
//     swarm with its built-in discovery key). Transfers are merkle-verified
//     by hypercore; on top, each file's byte size is pinned below, so a
//     truncated or drifted blob fails the lane instead of poisoning it.
//   - ABOT_MODELS_DIR overrides provisioning entirely (local runs, see
//     scripts/download-model-abot.sh).
//   - The fixed-scene walk lane additionally needs a scene pack
//     (scene.safetensors); it is not part of the published set, so that lane
//     passes as a no-op with an explanatory message when absent.
//
// Gate: the lanes run on the Linux x64 GPU legs in CI (NO_GPU excludes the
// arm64 legs) and anywhere ABOT_MODELS_DIR points at a provisioned set.
// Plain local runs skip rather than surprise-download ~13 GB.

const path = require('bare-path')
const os = require('bare-os')
const proc = require('bare-process')
const fs = require('bare-fs')
const test = require('brittle')

// Package-name imports (not '../../*.js'): the mobile E2E harness copies the
// test files into its own app tree and bundles them, where only the installed
// @qvac/diffusion-cpp package resolves - same reason the newest sibling tests
// import this way.
const VideoStableDiffusion = require('@qvac/diffusion-cpp/video')
const WorldStableDiffusion = require('@qvac/diffusion-cpp/world')
const { readImageDimensions } = require('@qvac/diffusion-cpp/addon.js')
const { ensureModelPath, setupJsLogger } = require('./utils.js')

// The registry client is a devDependency used only by the desktop provisioning
// path (the lanes skip on mobile). The indirect specifier keeps the literal out
// of the mobile bundler's static module traversal, which would otherwise fail
// the whole bundle on a module the app never loads.
const REGISTRY_CLIENT_PKG = '@qvac/registry-client'

// P2P registry namespace of the validated set. 's3' is the registry's
// source LABEL for these entries (a key namespace in the public registry
// protocol - the client streams the blobs from the P2P swarm).
const REGISTRY_PATH = 'qvac_models_compiled/ABot-World-0-5B-LF/2026-07-17'
const REGISTRY_SOURCE = 's3'
const DIT_NAME = 'abot-world-0-5b-lf-dit-q8_0.gguf'
const VAE_NAME = 'wan2.2_vae_f16.gguf'
const TAEHV_NAME = 'taew2_2_f16.gguf'
const T5_Q8_NAME = 'umt5-xxl-enc-q8_0.gguf'
const SCENE_NAME = 'scene.safetensors'
// Exact byte sizes of the published blobs (drift/truncation tripwire).
const SET_BYTES = {
  [DIT_NAME]: 5_885_489_920,
  [VAE_NAME]: 1_409_493_568,
  [TAEHV_NAME]: 22_844_832,
  [T5_Q8_NAME]: 6_035_988_320
}

const noGpu = proc.env && proc.env.NO_GPU === 'true'
const isLinux = os.platform() === 'linux'
const isX64 = os.arch() === 'x64'
const overrideDir = proc.env.ABOT_MODELS_DIR || ''
const canFetchRegistry = isLinux && isX64 && proc.env.CI === 'true'

const skip = noGpu || (!overrideDir && !canFetchRegistry)

console.log(
  '[ABot-World] skip:',
  skip,
  'override:',
  !!overrideDir,
  'registryFetch:',
  canFetchRegistry
)

function isComplete(dest, bytes) {
  try {
    return fs.statSync(dest).size === bytes
  } catch (_) {
    return false
  }
}

async function provisionFromRegistry(dir) {
  fs.mkdirSync(dir, { recursive: true })
  const missing = Object.keys(SET_BYTES).filter(
    (name) => !isComplete(path.join(dir, name), SET_BYTES[name])
  )
  const sceneMissing = !fs.existsSync(path.join(dir, SCENE_NAME))
  if (missing.length === 0 && !sceneMissing) return

  // Lazy require: only lanes that actually provision touch the swarm stack.
  const { QVACRegistryClient } = require(REGISTRY_CLIENT_PKG)
  const client = new QVACRegistryClient()
  await client.ready()
  try {
    for (const name of missing) {
      const dest = path.join(dir, name)
      console.log(`[ABot-World] downloading ${name} from the P2P registry ...`)
      try {
        await client.downloadModel(`${REGISTRY_PATH}/${name}`, REGISTRY_SOURCE, {
          outputFile: dest,
          timeout: 1_800_000
        })
      } catch (err) {
        try {
          fs.unlinkSync(dest) // never leave a partial blob behind
        } catch (_) {}
        throw err
      }
      if (!isComplete(dest, SET_BYTES[name])) {
        const got = fs.existsSync(dest) ? fs.statSync(dest).size : 0
        try {
          fs.unlinkSync(dest)
        } catch (_) {}
        throw new Error(`${name}: downloaded ${got} bytes, expected ${SET_BYTES[name]}`)
      }
    }
    if (sceneMissing) {
      // Optional set member (fixed-scene walk lane no-ops without it).
      await client
        .downloadModel(`${REGISTRY_PATH}/${SCENE_NAME}`, REGISTRY_SOURCE, {
          outputFile: path.join(dir, SCENE_NAME),
          timeout: 300_000
        })
        .catch(() => {})
    }
  } finally {
    await client.close().catch(() => {})
  }
}

test(
  'ABot-World: model set loads; batch generation is guarded',
  { skip, timeout: 2_400_000 },
  async (t) => {
    setupJsLogger()

    const dir = overrideDir || path.resolve(__dirname, '../model/abot')
    if (!overrideDir) {
      await provisionFromRegistry(dir)
      t.pass('ABot GGUFs provisioned from the P2P registry and size-verified')
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
      await provisionFromRegistry(dir)
    }

    const scenePath = path.join(dir, SCENE_NAME)
    const taehvPath = path.join(dir, TAEHV_NAME)
    if (!fs.existsSync(scenePath) || !fs.existsSync(taehvPath)) {
      // t.comment, NOT t.pass: an absent model must read as "not exercised",
      // never as a passing assertion someone could mistake for coverage.
      t.comment(
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

// Shared world-generation-lane provisioning: fetch the model set, verify the
// encoders needed for native scene creation, and resolve the prompt encoder.
// Returns null (after t.pass) when the optional encoders are not provisioned.
async function provisionWorldGeneration(t) {
  const dir = overrideDir || path.resolve(__dirname, '../model/abot')
  if (!overrideDir) {
    await provisionFromRegistry(dir)
  }

  const taehvPath = path.join(dir, TAEHV_NAME)
  const vaePath = path.join(dir, VAE_NAME)
  if (!fs.existsSync(taehvPath) || !fs.existsSync(vaePath)) {
    // t.comment, NOT t.pass: see the walk lane - a skip must never register
    // as a passing assertion.
    t.comment(
      'world-generation lane skipped: taew2_2 / Wan2.2 VAE not provisioned ' +
        `(need ${TAEHV_NAME} + ${VAE_NAME} in ${dir})`
    )
    return null
  }

  // Prompt encoder resolution: prefer the model set's own umT5 GGUFs when
  // provisioned (registry set / ABOT_MODELS_DIR; Q8_0 is the validated
  // deployment quant), else fall back to the pinned-manifest safetensors the
  // Wan tests use. All three forms are gated against the golden PyTorch
  // extraction (prompt_embeds cosine 0.9973 F16 / 0.9969 Q8 CUDA, latents
  // 0.9987).
  let t5Xxl = ''
  for (const name of [T5_Q8_NAME, 'umt5-xxl-enc-f16.gguf']) {
    const candidate = path.join(dir, name)
    if (fs.existsSync(candidate)) {
      t5Xxl = candidate
      break
    }
  }
  if (!t5Xxl) {
    t5Xxl = await ensureModelPath({ modelName: 'umt5_xxl_fp16.safetensors' })
  }
  return { dir, taehvPath, vaePath, t5Xxl }
}

// Walk `world` through `tape` and return the frames of each block.
async function walkTape(world, tape) {
  const blocks = []
  for (const keys of tape) {
    const frames = []
    const response = await world.step(keys)
    await response
      .onUpdate((data) => {
        if (data instanceof Uint8Array) frames.push(data)
      })
      .await()
    blocks.push(frames)
  }
  return blocks
}

function framesAre(blocks, width, height, magic) {
  return blocks.every((frames) =>
    frames.every((frame) => {
      if (magic && !(frame[0] === magic[0] && frame[1] === magic[1])) return false
      const dims = readImageDimensions(frame)
      return dims && dims.width === width && dims.height === height
    })
  )
}

test(
  'ABot-World: full world generation - native scene creation + KV-cache walk',
  { skip, timeout: 2_400_000 },
  async (t) => {
    setupJsLogger()

    const provisioned = await provisionWorldGeneration(t)
    if (!provisioned) return
    const { dir, taehvPath, vaePath, t5Xxl } = provisioned

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

    // 2. Walk the newly created world with the KV cache on, covering the
    //    demo's input space: idle, move, move+camera chord, and the array
    //    form (bit 0..7 = W,A,S,D,I,J,K,L; see the unit matrix for the full
    //    mapping coverage).
    await t.execution(world.load(), 'walk session loads the natively created pack')

    // Busy contract: a second step while a block is still streaming must be
    // rejected, not queued - the demo's key loop relies on this.
    const inFlight = await world.step({ W: true })
    await t.exception(
      world.step({ S: true }),
      /already set|being processed/,
      'second step while a block streams is rejected'
    )
    const firstBlock = []
    await inFlight
      .onUpdate((data) => {
        if (data instanceof Uint8Array) firstBlock.push(data)
      })
      .await()
    t.is(firstBlock.length, 9, 'first block streams 9 frames (decoder warmup)')

    const blocks = await walkTape(world, [{}, { W: true, L: true }, ['S', 'J']])
    t.ok(
      blocks.every((frames) => frames.length === 12),
      'idle, W+L chord and S+J (array form) blocks stream 12 frames each'
    )
    t.ok(framesAre([firstBlock, ...blocks], 832, 480), 'every frame is an 832x480 image')

    // The walk must react to input: W+L output differs from the idle block.
    const idleLast = blocks[0][blocks[0].length - 1]
    const chordLast = blocks[1][blocks[1].length - 1]
    t.ok(
      idleLast.length !== chordLast.length || !idleLast.every((v, i) => v === chordLast[i]),
      'chord block produces different frames than idling'
    )

    // 3. unload() with a block still streaming: the in-flight response must
    //    SETTLE (unload cancels, then fails any admitted-but-unstarted job),
    //    and the instance must be reloadable and walkable afterwards -
    //    regression guard for the released busy-lock teardown.
    const abandoned = await world.step({ W: true })
    const abandonedOutcome = abandoned
      .onUpdate(() => {})
      .await()
      .then(
        () => 'resolved',
        (err) => `rejected (${(err && err.message) || err})`
      )
    await world.unload()
    const settledAs = await Promise.race([
      abandonedOutcome,
      new Promise((resolve) => setTimeout(() => resolve('HUNG'), 60_000))
    ])
    t.not(
      settledAs,
      'HUNG',
      `response left streaming at unload settles instead of hanging: ${settledAs}`
    )
    await t.execution(world.load(), 'same instance reloads after unload-with-inflight-work')
    const resumed = await world.step(['W'])
    const resumedFrames = []
    await resumed
      .onUpdate((data) => {
        if (data instanceof Uint8Array) resumedFrames.push(data)
      })
      .await()
    t.is(resumedFrames.length, 9, 'post-reload first block streams 9 frames (busy guard released)')

    // 4. cancel() during a streaming block: the in-flight step must never
    //    resolve as a success with a silently truncated frame stream - it
    //    rejects with the typed Diffusion/Cancelled error (the engine cannot
    //    abort mid-block, so 'resolved' is tolerated only for the race where
    //    the block finished before the cancel flag landed).
    const inflight = await world.step({ W: true })
    const inflightOutcome = inflight
      .onUpdate(() => {})
      .await()
      .then(
        () => 'resolved',
        (err) => `rejected (${(err && err.message) || err})`
      )
    await world.cancel()
    const cancelOutcome = await inflightOutcome
    t.ok(
      cancelOutcome === 'resolved' || /cancel/i.test(cancelOutcome),
      `cancelled step settles with the typed error (or won the race): ${cancelOutcome}`
    )

    await world.unload().catch(() => {})
  }
)

test(
  'ABot-World: world variations - small-image upscale, 448x256 output, JPEG frames',
  { skip, timeout: 2_400_000 },
  async (t) => {
    setupJsLogger()

    const provisioned = await provisionWorldGeneration(t)
    if (!provisioned) return
    const { dir, taehvPath, vaePath, t5Xxl } = provisioned

    // 284x400 portrait: cover-scale forces the upscale + aspect-crop branch
    // of the native fit (the main lane's 496x624 input covers downscale-crop
    // at the default 832x480). 448x256 is the validated low-VRAM resolution.
    const image = fs.readFileSync(path.resolve(__dirname, '../../assets/claude-shannon.jpg'))
    const scenePath = path.join(dir, 'scene-variations-e2e.safetensors')
    if (fs.existsSync(scenePath)) fs.unlinkSync(scenePath)

    const world = new WorldStableDiffusion({
      files: { model: path.join(dir, DIT_NAME), taehv: taehvPath, scene: scenePath },
      // frameJpegQuality exercises the demo's streaming transport (MJPEG).
      // kvCache deliberately NUMERIC: plain-JS callers write 1, and the
      // native handler map must parse it as true (regression: it used to
      // fail a literal 'true' comparison and silently keep the default).
      config: { seed: 42, kvCache: 1, frameJpegQuality: 60 },
      logger: console,
      opts: { stats: true }
    })

    const creation = await world.createScene({
      prompt:
        '| unknown | A realistic indoor scene with a person, natural ' +
        'lighting, detailed textures, stable forward motion.',
      image,
      t5: t5Xxl,
      vae: vaePath,
      output: scenePath,
      width: 448,
      height: 256
    })
    await creation.onUpdate(() => {}).await()
    t.ok(fs.existsSync(scenePath), '448x256 scene pack written from a 284x400 input')

    await t.execution(world.load(), 'walk session loads the 448x256 pack')
    const blocks = await walkTape(world, [{ W: true }, { W: true, I: true }])
    t.is(blocks[0].length, 9, 'first 448x256 block streams 9 frames')
    t.is(blocks[1].length, 12, 'second 448x256 block streams 12 frames')
    t.ok(
      framesAre(blocks, 448, 256, [0xff, 0xd8]),
      'every frame is a 448x256 JPEG (frameJpegQuality transport)'
    )
    await world.unload().catch(() => {})

    // Numeric-boolean handler proof, end to end: kvCache '1' must reach the
    // engine as TRUE - with localAttnSize 21 the compiled KV ring cannot hold
    // the window, so the load MUST fail fast. A silently-false kvCache (the
    // old literal-'true' comparison bug) would load fine and hide the
    // regression.
    const failFast = new WorldStableDiffusion({
      files: { model: path.join(dir, DIT_NAME), taehv: taehvPath, scene: scenePath },
      config: { seed: 42, kvCache: 1, localAttnSize: 21 },
      logger: console
    })
    await t.exception.all(
      async () => failFast.load(),
      /kvCache\/localAttnSize|walk session/i,
      'kvCache: 1 parses as true natively (engine KV fail-fast fires at load)'
    )
    await failFast.unload().catch(() => {})
  }
)
