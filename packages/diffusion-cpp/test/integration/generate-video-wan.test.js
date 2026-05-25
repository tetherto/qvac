'use strict'

// Wan 2.1 text-to-video end-to-end test.
//
// This test drives a real generate_video() call through the native addon. The three
// Wan 2.1 model files (~8 GB total) are fetched on demand via ensureModel
// into test/model/ on first run.
//
// Optional env vars:
//   WAN_MODELS_DIR  - reuse an existing models directory (e.g. the one
//                     populated by ./scripts/download-model-wan.sh).
//                     Files present here are used as-is; missing files
//                     fall back to the standard ensureModel download.
//   WAN_DEVICE      - 'gpu' (default) or 'cpu'
//
// The Wan ops (IM2COL_3D, PAD-left) require the ggml fork pinned through the
// qvac vcpkg registry.

const fs = require('bare-fs')
const path = require('bare-path')
const os = require('bare-os')
const proc = require('bare-process')
const test = require('brittle')
const binding = require('../../binding')
const VideoStableDiffusion = require('@qvac/diffusion-cpp/video')
const { detectPlatform, setupJsLogger, ensureModelPath } = require('./utils')

const isMobile = os.platform() === 'ios' || os.platform() === 'android'
const isDarwin = os.platform() === 'darwin'
const noGpu = proc.env && proc.env.NO_GPU === 'true'
const skip = isMobile || isDarwin || noGpu

const platform = detectPlatform()

const WAN_FILES = [
  {
    key: 'model',
    name: 'wan2.1_t2v_1.3B_fp16.safetensors',
    url: 'https://huggingface.co/Comfy-Org/Wan_2.1_ComfyUI_repackaged/resolve/main/split_files/diffusion_models/wan2.1_t2v_1.3B_fp16.safetensors'
  },
  {
    key: 'vae',
    name: 'wan_2.1_vae.safetensors',
    url: 'https://huggingface.co/Comfy-Org/Wan_2.1_ComfyUI_repackaged/resolve/main/split_files/vae/wan_2.1_vae.safetensors'
  },
  {
    key: 't5Xxl',
    name: 'umt5_xxl_fp16.safetensors',
    url: 'https://huggingface.co/Comfy-Org/Wan_2.1_ComfyUI_repackaged/resolve/main/split_files/text_encoders/umt5_xxl_fp16.safetensors'
  }
]

// Detects an MJPG AVI buffer with a basic RIFF/AVI/idx1 sniff. We only
// validate structural markers — strict bit-for-bit AVI parsing lives in
// the C++ test_avi_writer.cpp suite.
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

  // hdrl LIST should appear immediately after the AVI marker (offset 12).
  const hdrlList = ascii(12, 4) === 'LIST' && ascii(20, 4) === 'hdrl'

  // The idx1 chunk must appear somewhere — scan for the magic.
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

  // Count "00dc" frame markers (uncompressed video frames in an MJPG list).
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

// Minimum-cost configuration for CI. Wan 2.1's latent temporal packing
// requires 4*k+1 frames, so 5 is the minimum frame count. Steps and
// resolution are kept as low as possible to keep wall-clock under a minute
// on GPU runners; we only assert structural validity of the AVI output, not
// visual quality.
const SMOKE_FRAMES = 5
const SMOKE_STEPS = 1
const SMOKE_WIDTH = 416
const SMOKE_HEIGHT = 240
const SMOKE_FPS = 16
const SMOKE_SEED = 7
const SMOKE_PROMPT = 'a red fox running through snow at dusk'

test('Wan 2.1 T2V — smoke (txt2vid) generates a structurally valid AVI',
  { timeout: 600000, skip },
  async (t) => {
    setupJsLogger(binding)

    console.log('\n' + '='.repeat(60))
    console.log('WAN 2.1 T2V — INTEGRATION SMOKE')
    console.log('='.repeat(60))
    console.log(` Platform   : ${platform}`)
    console.log(` Frames     : ${SMOKE_FRAMES} @ ${SMOKE_FPS}fps`)
    console.log(` Size       : ${SMOKE_WIDTH}x${SMOKE_HEIGHT}`)
    console.log(` Steps      : ${SMOKE_STEPS}`)
    console.log(` Seed       : ${SMOKE_SEED}`)
    console.log(` Device     : ${(proc.env && proc.env.WAN_DEVICE) || 'gpu'}`)

    console.log('\n=== Ensuring Wan 2.1 model files ===')
    const overrideDir = proc.env && proc.env.WAN_MODELS_DIR
    const resolvedFiles = {}
    for (const entry of WAN_FILES) {
      const overridePath = overrideDir ? path.join(overrideDir, entry.name) : null
      let modelPath
      if (overridePath && fs.existsSync(overridePath)) {
        console.log(`[wan] Using override: ${overridePath}`)
        modelPath = overridePath
      } else {
        modelPath = await ensureModelPath({
          modelName: entry.name,
          downloadUrl: entry.url
        })
      }
      resolvedFiles[entry.key] = modelPath
      t.ok(fs.existsSync(modelPath), `Wan file present: ${entry.name}`)
    }
    const resolvedModelDir = path.dirname(resolvedFiles.model)

    const model = new VideoStableDiffusion({
      files: resolvedFiles,
      config: {
        threads: 4,
        device: (proc.env && proc.env.WAN_DEVICE) || 'gpu',
        diffusion_fa: true,
        offload_to_cpu: true,
        vae_tiling: true,
        verbosity: 2
      },
      logger: console,
      opts: { stats: true }
    })

    let avi = null
    const progressTicks = []
    const stringDataPayloads = []

    try {
      console.log('\n=== Loading Wan 2.1 T2V 1.3B ===')
      const tLoad = Date.now()
      await model.load()
      const loadMs = Date.now() - tLoad
      console.log(`Loaded in ${(loadMs / 1000).toFixed(1)}s`)
      t.ok(loadMs < 240000, `Wan model loaded within 240s (took ${(loadMs / 1000).toFixed(1)}s)`)
      t.is(model.getState().configLoaded, true, 'state.configLoaded flips to true after load()')

      console.log('\n=== Generating video ===')
      const tGen = Date.now()

      const response = await model.run({
        mode: 'txt2vid',
        prompt: SMOKE_PROMPT,
        width: SMOKE_WIDTH,
        height: SMOKE_HEIGHT,
        video_frames: SMOKE_FRAMES,
        fps: SMOKE_FPS,
        steps: SMOKE_STEPS,
        cfg_scale: 6.0,
        flow_shift: 3.0,
        seed: SMOKE_SEED
      })

      await response
        .onUpdate((data) => {
          if (data instanceof Uint8Array) {
            avi = data
          } else if (typeof data === 'string') {
            stringDataPayloads.push(data)
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
      // Wan generation is multi-phase (text encode, denoise loop, VAE
      // decode), and each phase emits its own progress sequence. The
      // exact (step, total) shape is an SD-cpp implementation detail
      // (it can include encoder ticks where step=0, etc.), so we only
      // assert the stream is non-empty and that every numeric tick has
      // finite step + finite total.
      t.ok(progressTicks.length > 0,
        `Received progress ticks (got ${progressTicks.length})`)
      t.ok(progressTicks.every((p) =>
        Number.isFinite(p.step) && Number.isFinite(p.total) && p.total >= 1
      ), 'every progress tick carries finite step + total >= 1')
      const phaseTotals = new Set(progressTicks.map((p) => p.total))
      t.ok(phaseTotals.size >= 1,
        `progress ticks span ${phaseTotals.size} distinct phase total(s)`)
      console.log('First/last progress tick:',
        JSON.stringify(progressTicks[0]),
        '→',
        JSON.stringify(progressTicks[progressTicks.length - 1]))

      // ── AVI buffer assertions ──────────────────────────────────────────
      t.ok(avi instanceof Uint8Array, 'received an AVI Uint8Array on the output stream')
      t.ok(avi && avi.length > 1024, `AVI buffer is >1KiB (${avi ? avi.length : 0} bytes)`)

      const sniff = sniffAvi(avi)
      t.is(sniff && sniff.error, null, 'AVI starts with the RIFF/AVI magic')
      if (sniff && !sniff.error) {
        t.ok(sniff.hdrlList, 'hdrl LIST chunk follows the AVI marker at offset 12')
        t.ok(sniff.hasIdx1, 'AVI contains an idx1 (frame index) chunk')
        // Each frame appears as an '00dc' fourCC twice -- once as the
        // movi-list chunk header, once as the corresponding idx1 entry.
        // Allow either pattern; require at least N markers though.
        t.ok(
          sniff.frameMarkers >= SMOKE_FRAMES &&
          sniff.frameMarkers <= SMOKE_FRAMES * 2,
          `AVI carries 5..10 '00dc' markers for ${SMOKE_FRAMES} frames ` +
          `(got ${sniff.frameMarkers})`
        )
        t.ok(sniff.riffSizeMatchesBuffer,
          'RIFF size header matches the actual buffer length (no trailing data)')
      }

      // Save artifact next to models dir for manual inspection.
      try {
        const artifactDir = path.resolve(resolvedModelDir, '../output')
        fs.mkdirSync(artifactDir, { recursive: true })
        const outPath = path.join(artifactDir, `wan-smoke-seed${SMOKE_SEED}.avi`)
        fs.writeFileSync(outPath, avi)
        console.log(`\nSaved → ${outPath}`)
      } catch (err) {
        console.log(`Could not save AVI artifact: ${err.message}`)
      }

      console.log('\n' + '='.repeat(60))
      console.log('TEST SUMMARY')
      console.log('='.repeat(60))
      console.log(` Load time       : ${(loadMs / 1000).toFixed(1)}s`)
      console.log(` Gen time        : ${(genMs / 1000).toFixed(1)}s`)
      console.log(` Progress ticks  : ${progressTicks.length}`)
      console.log(` String payloads : ${stringDataPayloads.length}`)
      console.log(` AVI size        : ${avi ? avi.length : 0} bytes`)
      console.log(` Frame markers   : ${sniff ? sniff.frameMarkers : 'n/a'}`)
      console.log('='.repeat(60))
    } finally {
      console.log('\n=== Cleanup ===')
      await model.unload()
      try { binding.releaseLogger() } catch (_) {}
      console.log('Done.')
    }
  }
)

test('Wan validation - sniffAvi self-test', async (t) => {
  // A minimal hand-rolled RIFF/AVI buffer to verify our sniffer would
  // accept the structural markers we expect from the C++ AviWriter.
  const buf = new Uint8Array(64)
  // 'RIFF'
  buf[0] = 0x52; buf[1] = 0x49; buf[2] = 0x46; buf[3] = 0x46
  // size = 56 (file size - 8)
  buf[4] = 56; buf[5] = 0; buf[6] = 0; buf[7] = 0
  // 'AVI '
  buf[8] = 0x41; buf[9] = 0x56; buf[10] = 0x49; buf[11] = 0x20
  // 'LIST'
  buf[12] = 0x4C; buf[13] = 0x49; buf[14] = 0x53; buf[15] = 0x54
  // size 4
  buf[16] = 4; buf[17] = 0; buf[18] = 0; buf[19] = 0
  // 'hdrl'
  buf[20] = 0x68; buf[21] = 0x64; buf[22] = 0x72; buf[23] = 0x6C
  // sprinkle one '00dc' marker
  buf[24] = 0x30; buf[25] = 0x30; buf[26] = 0x64; buf[27] = 0x63
  // 'idx1' near the end
  buf[40] = 0x69; buf[41] = 0x64; buf[42] = 0x78; buf[43] = 0x31

  const sniff = sniffAvi(buf)
  t.is(sniff.error, null, 'sniffer accepts a minimal RIFF/AVI/hdrl buffer')
  t.is(sniff.hdrlList, true)
  t.is(sniff.hasIdx1, true)
  t.is(sniff.frameMarkers, 1, 'finds the single 00dc marker')
  t.is(sniff.riffSizeMatchesBuffer, true, 'RIFF size header matches buffer length')
})

test('Wan validation - sniffAvi rejects non-AVI buffers', async (t) => {
  // sniffAvi() returns null only for inputs that aren't even a valid
  // Uint8Array of >=64 bytes (i.e. "structurally impossible to be AVI").
  t.is(sniffAvi(null), null, 'null returns null (not a Uint8Array)')
  t.is(sniffAvi(new Uint8Array(0)), null, 'empty Uint8Array returns null (too short)')
  t.is(sniffAvi(new Uint8Array(63)), null, '63-byte buffer returns null (one short of minimum)')

  // Right length but no RIFF magic — should report a parse error.
  const allZero = sniffAvi(new Uint8Array(64))
  t.ok(allZero && /bad RIFF magic/.test(allZero.error),
    'all-zero 64-byte buffer reports a parse error, not null')

  // RIFF + wrong inner magic (e.g. WAVE) — should be flagged distinctly.
  const wrong = new Uint8Array(64)
  wrong[0] = 0x52; wrong[1] = 0x49; wrong[2] = 0x46; wrong[3] = 0x46 // RIFF
  wrong[8] = 0x57; wrong[9] = 0x41; wrong[10] = 0x56; wrong[11] = 0x45 // WAVE
  const wrongSniff = sniffAvi(wrong)
  t.ok(wrongSniff && /bad AVI marker/.test(wrongSniff.error),
    'rejects RIFF buffer with non-AVI inner magic')
})
