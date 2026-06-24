'use strict'

// QVAC-20557 DIAGNOSTIC (DO NOT MERGE) — main-baseline 12 kHz tone check.
//
// Runs Chatterbox **turbo** end-to-end on the **CPU** (useGPU:false) and
// asserts the generated audio is free of the constant ~12 kHz (Nyquist)
// whine.  On a Mali device main declines Chatterbox-on-GPU by policy, so
// this CPU path is exactly the audio Mali users get today.  Purpose:
// detect — without pulling the WAV off the device — whether CURRENT main
// already emits the tone on Mali (the armv9.0 ggml-cpu conv_transpose
// ISTFT artifact).  A red here (tonePresent=true) means main IS broken on
// this device.
//
// Detector: ../utils/toneAnalysis.js (Nyquist DFT-bin energy fraction;
// host-validated ~1e8x separation, threshold 0.1).  The `[12khz-diag]`
// line lands in the device-farm logcat for offline reading.

const os = require('bare-os')
const path = require('bare-path')
const test = require('brittle')

const { loadChatterboxTTS, runChatterboxTTS } = require('../utils/runChatterboxTTS')
const { ensureChatterboxModels } = require('../utils/downloadModel')
const { analyzeNyquistTone } = require('../utils/toneAnalysis')

const platform = os.platform()
const isMobile = platform === 'ios' || platform === 'android'
const SAMPLE_RATE = 24000
const TONE_TEXT = 'The quick brown fox jumps over the lazy dog.'

function getBaseDir () {
  return isMobile && global.testDir ? global.testDir : '.'
}

test('Chatterbox turbo CPU: output is free of the 12 kHz Nyquist tone', { timeout: 1800000 }, async (t) => {
  const baseDir = getBaseDir()
  const download = await ensureChatterboxModels({ targetDir: path.join(baseDir, 'models') })
  if (!download.success) {
    t.fail('Chatterbox turbo GGUFs not available - registry fetch failed.')
    return
  }

  const model = await loadChatterboxTTS({ modelDir: download.targetDir, useGPU: false, seed: 42 })
  try {
    const result = await runChatterboxTTS(
      model,
      { text: TONE_TEXT, seed: 42 },
      { minSamples: 5000 },
      { sampleRate: SAMPLE_RATE, engineTag: 'Chatterbox turbo CPU' }
    )
    t.ok(result.passed, 'turbo CPU synth produced audio within expectations')
    t.ok(result.data.sampleCount > 0, 'turbo CPU produced audio')

    const st = result.data?.stats || {}
    const tone = analyzeNyquistTone(result.data.samples, result.data.sampleRate)
    console.log(`[12khz-diag] variant=turbo backend=cpu backendDevice=${st.backendDevice} gpuUnsupported=${st.gpuUnsupported} n=${tone.n} rms=${tone.rms.toFixed(2)} zcr=${tone.zcr.toFixed(4)} nyquistEnergyFraction=${tone.nyquistEnergyFraction.toFixed(6)} tonePresent=${tone.tonePresent}`)

    t.is(tone.tonePresent, false, 'turbo CPU output has NO 12 kHz Nyquist tone (nyquistEnergyFraction <= 0.1)')
  } finally {
    try { await model.unload() } catch (_e) {}
  }
})
