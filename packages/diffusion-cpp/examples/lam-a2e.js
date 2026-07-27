'use strict'

const process = require('bare-process')
const fs = require('bare-fs')
const { LamAudio2Expression } = require('../index')
const { setLogger, releaseLogger } = require('../addonLogging')

// ---------------------------------------------------------------------------
// Standalone LAM audio2expression (ARKit-52 blendshapes)
//
// Converts 16kHz mono PCM audio into per-frame ARKit-52 blendshape weights,
// suitable for driving a lip-sync / facial-expression avatar pipeline.
//
// Model:
//   Set LAM_A2E_GGUF to the model path, or place it at
//   /tmp/qvac-lipsync-assets/lam-audio2exp-f32.gguf.
//
// Audio input (first match wins):
//   AUDIO_PATH     — any container ffmpeg can demux (wav, mp3, m4a, ...),
//                    decoded to 16kHz mono float32 on the fly via
//                    @qvac/decoder-audio.
//   AUDIO_PCM_PATH — a file of raw little-endian float32 PCM samples at 16kHz
//                    mono, as produced by scripts/wav-to-pcm.js.
//   neither        — a short synthetic sine-wave tone, so the example runs
//                    without any external audio asset.
//
// Output:
//   OUT_PATH       — optional. Writes the full coefficient set instead of only
//                    summarising it on stdout. A .json suffix produces a
//                    readable file with timestamps and blendshape names; any
//                    other suffix produces raw little-endian float32 in
//                    (frames x 52) row-major order, the same layout the parity
//                    fixtures use.
// ---------------------------------------------------------------------------
const SAMPLE_RATE = 16000
const N_COEFFS = 52
const FPS = 30

// Mirrors the lam-audio2exp.coeff_names array stored in the GGUF, which is
// itself Apple's fixed ARKit-52 ordering. The addon returns bare float arrays,
// so pairing them with names has to happen on this side.
const ARKIT52_NAMES = [
  'browDownLeft', 'browDownRight', 'browInnerUp', 'browOuterUpLeft',
  'browOuterUpRight', 'cheekPuff', 'cheekSquintLeft', 'cheekSquintRight',
  'eyeBlinkLeft', 'eyeBlinkRight', 'eyeLookDownLeft', 'eyeLookDownRight',
  'eyeLookInLeft', 'eyeLookInRight', 'eyeLookOutLeft', 'eyeLookOutRight',
  'eyeLookUpLeft', 'eyeLookUpRight', 'eyeSquintLeft', 'eyeSquintRight',
  'eyeWideLeft', 'eyeWideRight', 'jawForward', 'jawLeft', 'jawOpen',
  'jawRight', 'mouthClose', 'mouthDimpleLeft', 'mouthDimpleRight',
  'mouthFrownLeft', 'mouthFrownRight', 'mouthFunnel', 'mouthLeft',
  'mouthLowerDownLeft', 'mouthLowerDownRight', 'mouthPressLeft',
  'mouthPressRight', 'mouthPucker', 'mouthRight', 'mouthRollLower',
  'mouthRollUpper', 'mouthShrugLower', 'mouthShrugUpper', 'mouthSmileLeft',
  'mouthSmileRight', 'mouthStretchLeft', 'mouthStretchRight',
  'mouthUpperUpLeft', 'mouthUpperUpRight', 'noseSneerLeft',
  'noseSneerRight', 'tongueOut'
]
const DEFAULT_MODEL_PATH = '/tmp/qvac-lipsync-assets/lam-audio2exp-f32.gguf'
const MODEL_PATH = process.env.LAM_A2E_GGUF || DEFAULT_MODEL_PATH
const AUDIO_PCM_PATH = process.env.AUDIO_PCM_PATH || ''
const AUDIO_PATH = process.env.AUDIO_PATH || ''
const OUT_PATH = process.env.OUT_PATH || ''

function generateSyntheticPcm (durationSeconds) {
  const sampleCount = Math.round(SAMPLE_RATE * durationSeconds)
  const pcm = new Float32Array(sampleCount)
  const toneHz = 220
  for (let i = 0; i < sampleCount; i++) {
    pcm[i] = 0.2 * Math.sin((2 * Math.PI * toneHz * i) / SAMPLE_RATE)
  }
  return pcm
}

function loadPcmFromFile (filePath) {
  const buf = fs.readFileSync(filePath)
  return new Float32Array(buf.buffer, buf.byteOffset, Math.floor(buf.byteLength / 4))
}

// Required lazily so the synthetic and raw-PCM paths keep working when the
// optional @qvac/decoder-audio devDependency is not installed.
async function decodeAudioFile (filePath) {
  const { FFmpegDecoder } = require('@qvac/decoder-audio')

  // audioFormat must be passed explicitly: the constructor defaults to
  // 's16le' even though its JSDoc advertises 'f32le'.
  const decoder = new FFmpegDecoder({
    config: { audioFormat: 'f32le', sampleRate: SAMPLE_RATE }
  })
  await decoder.load()

  try {
    const chunks = []
    const response = await decoder.run(fs.createReadStream(filePath))
    await response
      .onUpdate((output) => {
        if (output && output.outputArray) chunks.push(new Uint8Array(output.outputArray))
      })
      .await()

    const pcmBytes = Buffer.concat(chunks)
    return new Float32Array(
      pcmBytes.buffer,
      pcmBytes.byteOffset,
      Math.floor(pcmBytes.byteLength / 4)
    )
  } finally {
    await decoder.unload()
  }
}

function writeFrames (outPath, frames) {
  if (outPath.endsWith('.json')) {
    // Names are emitted once at the top level rather than per frame; repeating
    // them 330 times would inflate the file by an order of magnitude for no
    // added information. Each frame's arkit52 array is index-aligned to them.
    const payload = {
      sampleRate: SAMPLE_RATE,
      fps: FPS,
      nCoeffs: N_COEFFS,
      frameCount: frames.length,
      durationSeconds: Number((frames.length / FPS).toFixed(3)),
      coeffNames: ARKIT52_NAMES,
      frames: frames.map((f) => ({
        timestampUs: f.timestampUs,
        arkit52: Array.from(f.arkit52)
      }))
    }
    fs.writeFileSync(outPath, JSON.stringify(payload, null, 2))
    return fs.statSync(outPath).size
  }

  // Raw float32 matrix. Deliberately headerless so it can be diffed straight
  // against a reference dump without a parser in the way.
  const flat = new Float32Array(frames.length * N_COEFFS)
  for (let i = 0; i < frames.length; i++) {
    flat.set(frames[i].arkit52, i * N_COEFFS)
  }
  const bytes = Buffer.from(flat.buffer, flat.byteOffset, flat.byteLength)
  fs.writeFileSync(outPath, bytes)
  return bytes.byteLength
}

async function loadAudio () {
  if (AUDIO_PATH) return { pcm: await decodeAudioFile(AUDIO_PATH), source: AUDIO_PATH }
  if (AUDIO_PCM_PATH) return { pcm: loadPcmFromFile(AUDIO_PCM_PATH), source: AUDIO_PCM_PATH }
  return { pcm: generateSyntheticPcm(2), source: '(synthetic sine tone)' }
}

async function main () {
  if (!fs.existsSync(MODEL_PATH)) {
    console.error(`LAM audio2expression model not found: ${MODEL_PATH}`)
    console.error('Set LAM_A2E_GGUF to the model path, e.g.:')
    console.error('  LAM_A2E_GGUF=/path/to/lam-audio2exp-f32.gguf node examples/lam-a2e.js')
    process.exit(1)
  }

  const { pcm, source } = await loadAudio()

  console.log('Standalone LAM audio2expression')
  console.log('================================')
  console.log('Model :', MODEL_PATH)
  console.log(
    'Audio :',
    source,
    `(${pcm.length} samples @ ${SAMPLE_RATE}Hz = ${(pcm.length / SAMPLE_RATE).toFixed(2)}s)`
  )
  console.log()

  // Native C++ logs are process-global; configure them once via addonLogging.
  setLogger((priority, message) => {
    const labels = ['ERROR', 'WARN', 'INFO', 'DEBUG']
    console.log(`[C++ ${labels[priority] || priority}] ${message}`)
  })

  const a2e = new LamAudio2Expression({
    files: {
      model: MODEL_PATH
    },
    config: {
      identityIndex: 0
    },
    logger: console
  })

  try {
    console.log('Loading LAM audio2expression weights...')
    const tLoad = Date.now()
    await a2e.load()
    console.log(`Loaded in ${((Date.now() - tLoad) / 1000).toFixed(1)}s\n`)

    console.log('Running audio2expression inference...')
    const t0 = Date.now()
    const response = await a2e.run(pcm, { sampleRate: SAMPLE_RATE })

    let frames = []
    await response
      .onUpdate((data) => {
        if (typeof data !== 'string') return
        try {
          const parsed = JSON.parse(data)
          if (Array.isArray(parsed.frames)) frames = parsed.frames
        } catch (_err) {
          // Non-JSON output payloads are ignored by this example.
        }
      })
      .await()

    console.log(`Inference completed in ${((Date.now() - t0) / 1000).toFixed(1)}s — got ${frames.length} frame(s)`)
    if (frames.length > 0) {
      const first = frames[0]
      console.log('First frame timestampUs:', first.timestampUs)
      console.log('First frame arkit52[0..4]:', first.arkit52.slice(0, 5))

      if (OUT_PATH) {
        const written = writeFrames(OUT_PATH, frames)
        console.log(
          `\nWrote ${frames.length} x ${N_COEFFS} coefficients ` +
            `(${written} bytes) to ${OUT_PATH}`
        )
      } else {
        console.log('\nSet OUT_PATH to save all coefficients to a file.')
      }
    }
  } finally {
    console.log('Unloading LAM audio2expression...')
    await a2e.unload()
    releaseLogger()
    console.log('Done.')
  }
}

main().catch((err) => {
  console.error('Fatal:', err.message || err)
  process.exit(1)
})
