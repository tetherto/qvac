'use strict'

// QVAC-20557 — on-device audio-correctness gate for the two Chatterbox Mali fixes.
// DO-NOT-MERGE CI-validation: this branch pins both fix branches via
// packages/tts-ggml/ports/{tts-cpp,ggml-speech} overlays, so on a Pixel 9
// (Tensor/Mali) these assertions prove both fixes produce proper audio.
//
//   - Bug 1 (CPU/SVE 12 kHz tone): nyquistEnergyFraction < 0.1.
//     Calibrated on real Pixel-9a audio: clean ~1e-8 vs the SVE tone ~0.635.
//   - Bug 2 (Mali GPU "blank+beeps"/f0->NaN): activeFraction > 0.4.
//     Calibrated: clean ~0.60 vs broken ~0.28. (The break carries no Nyquist
//     energy, so nyqFrac alone misses it.)
//
// The GPU run on Mali exercises BOTH fixes (CFM attention on the GPU + the
// CPU/SVE-routed HiFT conv_transpose). The CPU run exercises Bug 1 only.
// On clean platforms (Adreno / Metal / desktop) both runs pass — no-regression
// coverage. Metrics are emitted via t.comment so thresholds are tunable from CI.

const test = require('brittle')
const os = require('bare-os')
const path = require('bare-path')

const { loadChatterboxTTS, runChatterboxTTS } = require('../utils/runChatterboxTTS')
const { ensureChatterboxModels } = require('../utils/downloadModel')
const { analyzeSamples } = require('../utils/toneAnalysis')

const platform = os.platform()
const isMobile = platform === 'ios' || platform === 'android'

function getBaseDir () {
  return isMobile && global.testDir ? global.testDir : '.'
}

// A dense, run-on sentence (few long pauses) keeps the clean activeFraction high.
const TEXT = 'The quick brown fox jumps over the lazy dog, and then it runs across the open field, past the winding river, and deep into the quiet forest well before nightfall.'

// Gates calibrated on Freddy's real Pixel-9a round-1 WAVs.
const NYQ_MAX = 0.1 // Bug-1 SVE tone: clean ~1e-8, toney ~0.635
const ACTIVE_MIN = 0.4 // Bug-2 GPU blank+beeps: clean ~0.60, broken ~0.28
const RMS_MIN = 0.005
const RMS_MAX = 0.25

const EXPECTATION = { minSamples: 5000, maxSamples: 5000000, minDurationMs: 200, maxDurationMs: 300000 }

// result.data.samples is Int16-range PCM; normalise to [-1,1] for amplitude
// metrics. nyquistEnergyFraction is a ratio (scale-invariant) regardless.
function toFloat (pcm) {
  let peak = 0
  for (let i = 0; i < pcm.length; i++) {
    const a = pcm[i] < 0 ? -pcm[i] : pcm[i]
    if (a > peak) peak = a
  }
  const scale = peak > 1.5 ? 1 / 32768 : 1 // already float if peak <= 1.5
  const out = new Float32Array(pcm.length)
  for (let i = 0; i < pcm.length; i++) out[i] = pcm[i] * scale
  return out
}

async function synthAndAnalyze (t, useGPU, label) {
  const baseDir = getBaseDir()
  const download = await ensureChatterboxModels({ targetDir: path.join(baseDir, 'models') })
  if (!download.success) {
    t.fail(`${label}: Chatterbox GGUFs not available - registry fetch failed`)
    return null
  }

  const model = await loadChatterboxTTS({ modelDir: download.targetDir, language: 'en', useGPU })
  t.ok(model, `${label}: Chatterbox model loaded`)
  try {
    const result = await runChatterboxTTS(model, { text: TEXT, saveWav: false }, EXPECTATION)
    console.log(result.output)
    t.ok(result.passed, `${label}: synthesis passes duration/sample expectations`)
    if (!result.data || !result.data.samples || result.data.sampleCount <= 0) {
      t.fail(`${label}: no audio samples returned`)
      return null
    }

    const st = result.data.stats || {}
    const a = analyzeSamples(toFloat(result.data.samples), result.data.reportedSampleRate || 24000)
    t.comment(`${label}: backendDevice=${st.backendDevice} backendId=${st.backendId} gpuUnsupported=${st.gpuUnsupported} rtf=${st.realTimeFactor}`)
    t.comment(`${label}: nyqFrac=${a.nyquistEnergyFraction.toExponential(3)} activeFrac=${a.activeFraction.toFixed(3)} rms=${a.rms.toFixed(4)} highBand=${a.highBandEnergyFraction.toExponential(3)}`)
    return a
  } finally {
    try { await model.unload() } catch (_e) {}
  }
}

test('Chatterbox audio CLEAN on CPU — Bug-1 SVE Nyquist-tone gate', { timeout: 1800000 }, async (t) => {
  const a = await synthAndAnalyze(t, false, 'cpu')
  if (!a) return
  t.ok(a.nyquistEnergyFraction < NYQ_MAX, `cpu: no ~12 kHz Nyquist tone (nyqFrac ${a.nyquistEnergyFraction.toExponential(3)} < ${NYQ_MAX})`)
  t.ok(a.rms > RMS_MIN && a.rms < RMS_MAX, `cpu: rms in [${RMS_MIN}, ${RMS_MAX}] (got ${a.rms.toFixed(4)})`)
})

test('Chatterbox audio CLEAN on GPU — Bug-1 + Bug-2 gates', { timeout: 1800000 }, async (t) => {
  const a = await synthAndAnalyze(t, true, 'gpu')
  if (!a) return
  t.ok(a.nyquistEnergyFraction < NYQ_MAX, `gpu: no ~12 kHz Nyquist tone (nyqFrac ${a.nyquistEnergyFraction.toExponential(3)} < ${NYQ_MAX})`)
  t.ok(a.activeFraction > ACTIVE_MIN, `gpu: audio not collapsed to blank+beeps (activeFrac ${a.activeFraction.toFixed(3)} > ${ACTIVE_MIN})`)
  t.ok(a.rms > RMS_MIN && a.rms < RMS_MAX, `gpu: rms in [${RMS_MIN}, ${RMS_MAX}] (got ${a.rms.toFixed(4)})`)
})
