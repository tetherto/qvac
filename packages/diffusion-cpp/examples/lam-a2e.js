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
// Audio input:
//   Set AUDIO_PCM_PATH to a file containing raw little-endian float32 PCM
//   samples at 16kHz mono. If unset, a short synthetic sine-wave tone is
//   generated so the example can run without any external audio asset.
// ---------------------------------------------------------------------------
const SAMPLE_RATE = 16000
const DEFAULT_MODEL_PATH = '/tmp/qvac-lipsync-assets/lam-audio2exp-f32.gguf'
const MODEL_PATH = process.env.LAM_A2E_GGUF || DEFAULT_MODEL_PATH
const AUDIO_PCM_PATH = process.env.AUDIO_PCM_PATH || ''

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

async function main () {
  if (!fs.existsSync(MODEL_PATH)) {
    console.error(`LAM audio2expression model not found: ${MODEL_PATH}`)
    console.error('Set LAM_A2E_GGUF to the model path, e.g.:')
    console.error('  LAM_A2E_GGUF=/path/to/lam-audio2exp-f32.gguf node examples/lam-a2e.js')
    process.exit(1)
  }

  const pcm = AUDIO_PCM_PATH ? loadPcmFromFile(AUDIO_PCM_PATH) : generateSyntheticPcm(2)

  console.log('Standalone LAM audio2expression')
  console.log('================================')
  console.log('Model :', MODEL_PATH)
  console.log(
    'Audio :',
    AUDIO_PCM_PATH || '(synthetic sine tone)',
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
