'use strict'

// LTX-2.3 text-to-video (+ audio) end-to-end smoke test.
//
// LTX-2.3 is a joint audio+video model: one text prompt drives both the video
// frames and a synchronized audio track, which is muxed into the output AVI as
// a second stream. This test exercises the full load -> generate -> mux -> save
// path at the minimum-cost configuration (1 step, smallest valid shape) and
// asserts the AVI is structurally valid and carries an audio track.
//
// Because the LTX weight set is large (Q8_0 diffusion ~24 GB + Gemma-3-12b text
// encoder ~7 GB + video/audio VAE + connectors), this test does NOT auto-download
// by default. It runs when the weights are already present and skips otherwise.
//
// The run is load-bound, so to keep it fast the diffusion model and text encoder
// auto-resolve to the SMALLEST matching quant present in the models dir (a Q2_K
// diffusion loads in roughly half the time of Q8_0). Download a lighter quant
// with e.g. `./scripts/download-model-ltx.sh --q2k` and this test uses it with
// no edits. Per-component resolution: env override > smallest local match >
// default download (only with LTX_DOWNLOAD=true).
//
// Optional env vars:
//   LTX_MODELS_DIR  - directory holding the LTX weights (default: <pkg>/models)
//   LTX_MODEL_FILE  - exact diffusion gguf filename to use (skips auto-select)
//   LTX_LLM_FILE    - exact Gemma gguf filename to use (skips auto-select)
//   LTX_DOWNLOAD    - 'true' to download missing weights via ensureModel
//   LTX_DEVICE      - 'gpu' (default) or 'cpu'
//
// The LTX ops (IM2COL_3D, PAD, fused RoPE-flux, conv_1d F32 im2col) require the
// ggml fork pinned through the qvac vcpkg registry (qvac-ext-ggml 2026-06-06-ltx).

const fs = require('bare-fs')
const path = require('bare-path')
const os = require('bare-os')
const proc = require('bare-process')
const test = require('brittle')
const binding = require('../../binding')
const VideoStableDiffusion = require('@qvac/diffusion-cpp/video')
const { detectPlatform, setupJsLogger, ensureModelPath } = require('./utils')

const isMobile = os.platform() === 'ios' || os.platform() === 'android'
const noGpu = proc.env && proc.env.NO_GPU === 'true'

// File names + download URLs mirror scripts/download-model-ltx.sh.
const HF = 'https://huggingface.co'

// Fixed (non-quantized) LTX runtime components — always these exact files.
const FIXED_FILES = [
  {
    key: 'vae',
    name: 'ltx-2.3-22b-distilled_video_vae.safetensors',
    url: `${HF}/unsloth/LTX-2.3-GGUF/resolve/main/vae/ltx-2.3-22b-distilled_video_vae.safetensors`
  },
  {
    key: 'audioVae',
    name: 'ltx-2.3-22b-distilled_audio_vae.safetensors',
    url: `${HF}/unsloth/LTX-2.3-GGUF/resolve/main/vae/ltx-2.3-22b-distilled_audio_vae.safetensors`
  },
  {
    key: 'embeddingsConnectors',
    name: 'ltx-2.3-22b-distilled_embeddings_connectors.safetensors',
    url: `${HF}/unsloth/LTX-2.3-GGUF/resolve/main/text_encoders/ltx-2.3-22b-distilled_embeddings_connectors.safetensors`
  }
]

// Quantized components: LTX-2.3 ships only as a 22B model, so the sole lever on
// load time is the quant level. To keep this smoke test fast, we auto-select the
// SMALLEST matching quant present in the models dir (e.g. a Q2_K diffusion loads
// in roughly half the time of Q8_0) — load dominates the run, generation is
// already at the floor (1 step / 9 frames). Resolution order per component:
//   1. <COMPONENT>_FILE env override (exact filename within the models dir)
//   2. smallest local file matching the quant glob
//   3. default download (only when LTX_DOWNLOAD=true)
const QUANT_COMPONENTS = [
  {
    key: 'model',
    envVar: 'LTX_MODEL_FILE',
    glob: /^LTX-2\.3-22B-distilled-1\.1-.*\.gguf$/,
    // Default download is the lightest quant (Q2_K, ~12 GB): this is a
    // structural smoke test (valid AVI + audio track), not a quality bar, so the
    // fastest-loading quant is the right default for CI / fresh checkouts. A
    // heavier local quant is still preferred automatically when present.
    default: {
      name: 'LTX-2.3-22B-distilled-1.1-Q2_K.gguf',
      url: `${HF}/QuantStack/LTX-2.3-GGUF/resolve/main/LTX-2.3-distilled-1.1/LTX-2.3-22B-distilled-1.1-Q2_K.gguf`
    }
  },
  {
    key: 'llm',
    envVar: 'LTX_LLM_FILE',
    glob: /^gemma-3-12b-it-.*\.gguf$/,
    default: {
      name: 'gemma-3-12b-it-UD-Q4_K_XL.gguf',
      url: `${HF}/unsloth/gemma-3-12b-it-GGUF/resolve/main/gemma-3-12b-it-UD-Q4_K_XL.gguf`
    }
  }
]

const LTX_MODELS_DIR = (proc.env && proc.env.LTX_MODELS_DIR) ||
  path.resolve(__dirname, '../../models')
const allowDownload = !!(proc.env && proc.env.LTX_DOWNLOAD === 'true')

// Returns the smallest file in `dir` whose basename matches `re`, or null.
// Smallest == lowest-bit quant == fastest to load for the smoke test.
function smallestMatch (dir, re) {
  let best = null
  try {
    for (const name of fs.readdirSync(dir)) {
      if (!re.test(name)) continue
      const full = path.join(dir, name)
      let size
      try { size = fs.statSync(full).size } catch (_) { continue }
      if (!best || size < best.size) best = { name, size, path: full }
    }
  } catch (_) { /* dir missing */ }
  return best
}

// Resolves a quant component to a local path: env override > smallest match.
// Returns null when nothing local is available (caller may download).
function resolveQuantLocal (comp) {
  const override = proc.env && proc.env[comp.envVar]
  if (override) {
    const full = path.isAbsolute(override) ? override : path.join(LTX_MODELS_DIR, override)
    return fs.existsSync(full) ? { name: path.basename(full), path: full } : null
  }
  return smallestMatch(LTX_MODELS_DIR, comp.glob)
}

function localModelsPresent () {
  try {
    const fixedOk = FIXED_FILES.every((f) => fs.existsSync(path.join(LTX_MODELS_DIR, f.name)))
    const quantOk = QUANT_COMPONENTS.every((c) => resolveQuantLocal(c) !== null)
    return fixedOk && quantOk
  } catch (_) {
    return false
  }
}

const modelsPresent = localModelsPresent()
// Skip on mobile (cannot hold ~38 GB), on CPU-only runners (NO_GPU), and when
// the weights are neither present locally nor explicitly allowed to download.
const skip = isMobile || noGpu || (!modelsPresent && !allowDownload)

console.log(
  '[LTX Video Test] Platform:', os.platform(), 'Arch:', os.arch(),
  'NO_GPU:', noGpu, 'modelsPresent:', modelsPresent,
  'allowDownload:', allowDownload, '→ Skip:', skip
)

const platform = detectPlatform()

// Detects an MJPG AVI buffer with a basic RIFF/AVI/idx1 sniff. We only validate
// structural markers — strict bit-for-bit AVI parsing lives in the C++
// test_avi_writer.cpp suite. (Kept local to mirror generate-video-wan.test.js.)
function sniffAvi (buf) {
  if (!(buf instanceof Uint8Array) || buf.length < 64) return null

  const ascii = (i, n) => {
    let s = ''
    for (let j = 0; j < n; j++) s += String.fromCharCode(buf[i + j])
    return s
  }

  if (ascii(0, 4) !== 'RIFF') return { error: `bad RIFF magic: ${ascii(0, 4)}` }
  if (ascii(8, 4) !== 'AVI ') return { error: `bad AVI marker: ${ascii(8, 4)}` }

  const fileSize = buf[4] | (buf[5] << 8) | (buf[6] << 16) | (buf[7] << 24)

  const hdrlList = ascii(12, 4) === 'LIST' && ascii(20, 4) === 'hdrl'

  let hasIdx1 = false
  for (let i = 12; i < buf.length - 4; i++) {
    if (
      buf[i] === 0x69 && buf[i + 1] === 0x64 &&
      buf[i + 2] === 0x78 && buf[i + 3] === 0x31 // 'idx1'
    ) {
      hasIdx1 = true
      break
    }
  }

  let frameMarkers = 0
  for (let i = 12; i < buf.length - 4; i++) {
    if (
      buf[i] === 0x30 && buf[i + 1] === 0x30 &&
      buf[i + 2] === 0x64 && buf[i + 3] === 0x63 // '00dc'
    ) {
      frameMarkers++
    }
  }

  return {
    error: null,
    fileSize,
    hdrlList,
    hasIdx1,
    frameMarkers,
    riffSizeMatchesBuffer: fileSize === buf.length - 8
  }
}

// Minimum-cost LTX configuration. LTX shape rules: width/height must be
// multiples of 32, video_frames must be (8*k + 1). 9 frames is the smallest
// valid count; 1 step + 512x320 keeps wall-clock low — we only assert
// structural validity of the AVI + the presence of an audio track, not quality.
const SMOKE_PROMPT = 'a claymation cat playing piano'
const SMOKE_NEG_PROMPT = 'blurry, low quality, watermark'
const SMOKE_WIDTH = 512 // 16 x 32
const SMOKE_HEIGHT = 320 // 10 x 32
const SMOKE_FRAMES = 9 // 8*1 + 1
const SMOKE_STEPS = 1
const SMOKE_FPS = 24
const SMOKE_SEED = 42

test('LTX-2.3 T2V — smoke (txt2vid+audio) generates a structurally valid AVI',
  // Generous timeout: on a cold model cache the ~23 GB LTX weight set is pulled
  // inside the test via ensureModelPath; cached runs load + generate in <90s.
  { timeout: 1800000, skip },
  async (t) => {
    setupJsLogger(binding)

    console.log('\n' + '='.repeat(60))
    console.log('LTX-2.3 T2V — INTEGRATION SMOKE')
    console.log('='.repeat(60))
    console.log(` Platform   : ${platform}`)
    console.log(` Frames     : ${SMOKE_FRAMES} @ ${SMOKE_FPS}fps`)
    console.log(` Size       : ${SMOKE_WIDTH}x${SMOKE_HEIGHT}`)
    console.log(` Steps      : ${SMOKE_STEPS}`)
    console.log(` Seed       : ${SMOKE_SEED}`)
    console.log(` Models dir : ${LTX_MODELS_DIR}`)
    console.log(` Device     : ${(proc.env && proc.env.LTX_DEVICE) || 'gpu'}`)

    console.log('\n=== Ensuring LTX-2.3 model files ===')
    const resolvedFiles = {}

    // Quantized components: prefer the lightest local match; download the
    // default only when explicitly allowed.
    for (const comp of QUANT_COMPONENTS) {
      const local = resolveQuantLocal(comp)
      let modelPath
      if (local) {
        console.log(`[ltx] Using local (${comp.key}): ${local.name}`)
        modelPath = local.path
      } else {
        console.log(`[ltx] Downloading default (${comp.key}): ${comp.default.name}`)
        modelPath = await ensureModelPath({
          modelName: comp.default.name,
          downloadUrl: comp.default.url
        })
      }
      resolvedFiles[comp.key] = modelPath
      t.ok(fs.existsSync(modelPath), `LTX ${comp.key} present: ${path.basename(modelPath)}`)
    }

    // Fixed components: always the exact files.
    for (const entry of FIXED_FILES) {
      const localPath = path.join(LTX_MODELS_DIR, entry.name)
      let modelPath
      if (fs.existsSync(localPath)) {
        modelPath = localPath
      } else {
        console.log(`[ltx] Downloading: ${entry.name}`)
        modelPath = await ensureModelPath({
          modelName: entry.name,
          downloadUrl: entry.url
        })
      }
      resolvedFiles[entry.key] = modelPath
      t.ok(fs.existsSync(modelPath), `LTX file present: ${entry.name}`)
    }
    const resolvedModelDir = path.dirname(resolvedFiles.model)

    const model = new VideoStableDiffusion({
      files: resolvedFiles,
      config: {
        threads: 4,
        device: (proc.env && proc.env.LTX_DEVICE) || 'gpu',
        diffusion_fa: true,
        offload_to_cpu: true,
        vae_tiling: true,
        // LTX video VAE convolutions go through the direct (im2col-free) path;
        // the audio VAE F32 conv_1d path relies on the ggml 2026-06-06 type fix.
        vae_conv_direct: true,
        verbosity: 2
      },
      logger: console,
      opts: { stats: true }
    })

    let avi = null
    let stats = null
    const progressTicks = []

    try {
      console.log('\n=== Loading LTX-2.3 (video + audio VAE + connectors + Gemma) ===')
      const tLoad = Date.now()
      await model.load()
      const loadMs = Date.now() - tLoad
      console.log(`Loaded in ${(loadMs / 1000).toFixed(1)}s`)
      t.is(model.getState().configLoaded, true, 'state.configLoaded flips to true after load()')

      console.log('\n=== Generating video ===')
      const tGen = Date.now()

      const response = await model.run({
        mode: 'txt2vid',
        prompt: SMOKE_PROMPT,
        negative_prompt: SMOKE_NEG_PROMPT,
        width: SMOKE_WIDTH,
        height: SMOKE_HEIGHT,
        video_frames: SMOKE_FRAMES,
        fps: SMOKE_FPS,
        steps: SMOKE_STEPS,
        cfg_scale: 1.0,
        temporal_tiling: true,
        seed: SMOKE_SEED
      })

      response.on('stats', (s) => { stats = s })

      await response
        .onUpdate((data) => {
          if (data instanceof Uint8Array) {
            avi = data
          } else if (typeof data === 'string') {
            try {
              const tick = JSON.parse(data)
              if (typeof tick === 'object' && tick && 'step' in tick && 'total' in tick) {
                progressTicks.push(tick)
              }
            } catch (_) { /* not JSON */ }
          }
        })
        .await()

      const genMs = Date.now() - tGen
      console.log(`\nGenerated in ${(genMs / 1000).toFixed(1)}s`)

      // ── Progress assertions ─────────────────────────────────────────────
      t.ok(progressTicks.length > 0,
        `Received progress ticks (got ${progressTicks.length})`)
      t.ok(progressTicks.every((p) =>
        Number.isFinite(p.step) && Number.isFinite(p.total) && p.total >= 1
      ), 'every progress tick carries finite step + total >= 1')

      // ── AVI buffer assertions ──────────────────────────────────────────
      t.ok(avi instanceof Uint8Array, 'received an AVI Uint8Array on the output stream')
      t.ok(avi && avi.length > 1024, `AVI buffer is >1KiB (${avi ? avi.length : 0} bytes)`)

      const sniff = sniffAvi(avi)
      t.is(sniff && sniff.error, null, 'AVI starts with the RIFF/AVI magic')
      if (sniff && !sniff.error) {
        t.ok(sniff.hdrlList, 'hdrl LIST chunk follows the AVI marker at offset 12')
        t.ok(sniff.hasIdx1, 'AVI contains an idx1 (frame index) chunk')
        t.ok(
          sniff.frameMarkers >= SMOKE_FRAMES &&
          sniff.frameMarkers <= SMOKE_FRAMES * 2,
          `AVI carries ${SMOKE_FRAMES}..${SMOKE_FRAMES * 2} '00dc' markers ` +
          `(got ${sniff.frameMarkers})`
        )
        t.ok(sniff.riffSizeMatchesBuffer,
          'RIFF size header matches the actual buffer length (no trailing data)')
      }

      // ── Audio assertions (LTX is a joint audio+video model) ─────────────
      if (stats) {
        const hasAudio = stats.hasAudio === 1 || stats.hasAudio === true
        t.ok(hasAudio, 'LTX produced a synchronized audio track (stats.hasAudio)')
        console.log(`Audio: ${hasAudio ? `yes (${stats.audioSampleRate} Hz, muxed into AVI)` : 'none'}`)
      }

      // Save artifact for manual inspection.
      try {
        const artifactDir = path.resolve(resolvedModelDir, '../output')
        fs.mkdirSync(artifactDir, { recursive: true })
        const outPath = path.join(artifactDir, `ltx-smoke-seed${SMOKE_SEED}.avi`)
        fs.writeFileSync(outPath, avi)
        console.log(`\nSaved → ${outPath}`)
      } catch (err) {
        console.log(`Could not save AVI artifact: ${err.message}`)
      }

      console.log('\n' + '='.repeat(60))
      console.log('LTX TEST SUMMARY')
      console.log('='.repeat(60))
      console.log(` Load time       : ${(loadMs / 1000).toFixed(1)}s`)
      console.log(` Gen time        : ${(genMs / 1000).toFixed(1)}s`)
      console.log(` Progress ticks  : ${progressTicks.length}`)
      console.log(` AVI size        : ${avi ? avi.length : 0} bytes`)
      console.log(` Frame markers   : ${sniff ? sniff.frameMarkers : 'n/a'}`)
      console.log(` Has audio       : ${stats ? (stats.hasAudio === 1 || stats.hasAudio === true) : 'n/a'}`)
      console.log('='.repeat(60))
    } finally {
      console.log('\n=== Cleanup ===')
      await model.unload()
      try { binding.releaseLogger() } catch (_) {}
      console.log('Done.')
    }
  }
)
