'use strict'

// QVAC-20557 DIAGNOSTIC (DO NOT MERGE) — main-baseline 12 kHz tone check (MTL).
//
// Same as chatterbox-tone-cpu-turbo.test.js but for the **mtl** variant,
// to confirm the ~12 kHz (Nyquist) whine is variant-independent.  Runs
// Chatterbox mtl end-to-end on the **CPU** (useGPU:false) and asserts the
// output is tone-free.  On Mali, main runs this on the CPU (GPU declined),
// so a red here (tonePresent=true) means main IS broken on this device.
//
// Detector: ../utils/toneAnalysis.js (Nyquist DFT-bin energy fraction;
// host-validated threshold 0.1).  The `[12khz-diag]` line lands in the
// device-farm logcat for offline reading.

const os = require('bare-os')
const path = require('bare-path')
const test = require('brittle')

const { loadChatterboxTTS, runChatterboxTTS } = require('../utils/runChatterboxTTS')
const { ensureChatterboxMtlModels } = require('../utils/downloadModel')
const { analyzeNyquistTone } = require('../utils/toneAnalysis')

const platform = os.platform()
const isMobile = platform === 'ios' || platform === 'android'
const SAMPLE_RATE = 24000
const TONE_TEXT = 'The quick brown fox jumps over the lazy dog.'

function getBaseDir () {
  return isMobile && global.testDir ? global.testDir : '.'
}

test('Chatterbox mtl CPU: output is free of the 12 kHz Nyquist tone', { timeout: 1800000 }, async (t) => {
  const baseDir = getBaseDir()
  const download = await ensureChatterboxMtlModels({ targetDir: path.join(baseDir, 'models') })
  if (!download.success) {
    t.fail('Chatterbox mtl GGUFs not available - registry fetch failed.')
    return
  }

  // The mtl GGUFs are NOT the loadChatterboxTTS defaults (which are turbo);
  // derive the actual filenames from the download result and pass them
  // explicitly so the engine loads the mtl variant.
  const names = Object.keys(download.results)
  const t3Name = names.find(n => n.includes('t3'))
  const s3genName = names.find(n => n.includes('s3gen'))
  if (!t3Name || !s3genName) {
    t.fail(`Could not resolve mtl GGUF filenames from download result: ${names.join(', ')}`)
    return
  }

  const model = await loadChatterboxTTS({
    modelDir: download.targetDir,
    t3ModelPath: path.join(download.targetDir, t3Name),
    s3genModelPath: path.join(download.targetDir, s3genName),
    useGPU: false,
    seed: 42
  })
  try {
    const result = await runChatterboxTTS(
      model,
      { text: TONE_TEXT, seed: 42 },
      { minSamples: 5000 },
      { sampleRate: SAMPLE_RATE, engineTag: 'Chatterbox mtl CPU' }
    )
    t.ok(result.passed, 'mtl CPU synth produced audio within expectations')
    t.ok(result.data.sampleCount > 0, 'mtl CPU produced audio')

    const st = result.data?.stats || {}
    const tone = analyzeNyquistTone(result.data.samples, result.data.sampleRate)
    console.log(`[12khz-diag] variant=mtl backend=cpu backendDevice=${st.backendDevice} gpuUnsupported=${st.gpuUnsupported} n=${tone.n} rms=${tone.rms.toFixed(2)} zcr=${tone.zcr.toFixed(4)} nyquistEnergyFraction=${tone.nyquistEnergyFraction.toFixed(6)} tonePresent=${tone.tonePresent}`)

    t.is(tone.tonePresent, false, 'mtl CPU output has NO 12 kHz Nyquist tone (nyquistEnergyFraction <= 0.1)')
  } finally {
    try { await model.unload() } catch (_e) {}
  }
})
