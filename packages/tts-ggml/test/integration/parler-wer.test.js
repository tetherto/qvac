'use strict'

// Parler content-correctness (WER): synthesize English, transcribe with
// whisper (ggml-small), and assert the word-error-rate stays within a
// calibrated threshold. This proves the audio actually says the words,
// beyond the smoke/determinism checks in parler.test.js. Mirrors the
// chatterbox WER leg in addon.test.js (whisper ASR + wordErrorRate).
//
// macOS-desktop only (isDarwin): the whisper WER infra is desktop-only
// across the tts-ggml suite. Runs on both the Metal GPU runner and the
// no_gpu CPU runner (backend chosen like the quant loop). large-v1 is
// RAM-gated; both tiers skip cleanly if their GGUF isn't staged.

const os = require('bare-os')
const path = require('bare-path')
const proc = require('bare-process')
const test = require('brittle')

const { loadParlerTTS, runParlerTTS } = require('../utils/runParlerTTS')
const { ensureParlerModel, ensureWhisperModel } = require('../utils/downloadModel')
const { loadWhisper, runWhisper } = require('../utils/runWhisper')

const platform = os.platform()
const isDarwin = platform === 'darwin'
const isApple = platform === 'darwin' || platform === 'ios'
const NO_GPU = proc.env && proc.env.NO_GPU === 'true'
const LARGE_MIN_RAM_BYTES = 16 * 1024 ** 3

// Calibrated 2026-07-23 (M5, Metal): whisper ggml-small transcribed every
// sentence below at 0.0% WER on BOTH mini + large. Threshold = 0 + buffer;
// 0.2 gives headroom for ASR variance / the coarse 0.1 WER granularity while
// staying 2x stricter than chatterbox's 0.4 — so it still asserts correctness.
const WER_THRESHOLD = 0.2

// Clear English sentences, all >= 9 words (a single ASR slip stays <= ~0.11,
// so the 0.1-rounded WER isn't hair-triggered by one word). Common vocabulary.
const WER_SENTENCES = [
  'The quick brown fox jumps over the lazy dog.',
  'Please remember to bring your umbrella and a warm jacket.',
  'Artificial intelligence is transforming the way we work and live.'
]

const PARLER_WER_TIERS = [{ variant: 'mini' }, { variant: 'large' }]

function getBaseDir() {
  const isMobile = platform === 'ios' || platform === 'android'
  return isMobile && global.testDir ? global.testDir : '.'
}

for (const { variant } of PARLER_WER_TIERS) {
  test(
    `Parler WER (${variant}): English synthesis transcribes within ${(WER_THRESHOLD * 100).toFixed(0)}%`,
    { timeout: 1800000, skip: !isDarwin },
    async (t) => {
      if (variant === 'large' && os.totalmem() < LARGE_MIN_RAM_BYTES) {
        t.pass(
          `skipped: large-v1 needs >= 16 GiB RAM (have ${(os.totalmem() / 1024 ** 3).toFixed(1)} GiB)`
        )
        return
      }

      const baseDir = getBaseDir()
      const modelsDir = path.join(baseDir, 'models')
      const download = await ensureParlerModel({ targetDir: modelsDir, variant, quant: 'q8_0' })
      if (!download.success) {
        t.pass(`skipped: parler ${variant} q8_0 GGUF not staged`)
        return
      }

      const whisperDir = path.join(modelsDir, 'whisper')
      const whisperPath = path.join(whisperDir, 'ggml-small.bin')
      try {
        await ensureWhisperModel(whisperPath)
      } catch (e) {
        t.pass(`skipped: whisper ggml-small unavailable (${e.message})`)
        return
      }

      const useGPU = isApple && !NO_GPU
      const model = await loadParlerTTS({ parlerModelPath: download.path, seed: 42, useGPU })
      const entries = []
      try {
        for (const text of WER_SENTENCES) {
          const r = await runParlerTTS(model, { text }, { minSamples: 5000 })
          t.ok(r.passed, `parler ${variant} synth passes expectations`)
          t.ok(r.data.sampleCount > 0, `parler ${variant} produced audio`)
          entries.push({ text, wavBuffer: r.data.wavBuffer })
        }
      } finally {
        await model.unload()
      }

      const whisper = await loadWhisper({
        modelName: 'ggml-small.bin',
        diskPath: whisperDir,
        language: 'en'
      })
      try {
        for (const e of entries) {
          const { wer } = await runWhisper(whisper, e.text, e.wavBuffer)
          const pct = (wer * 100).toFixed(1)
          console.log(`>>> [WER] parler ${variant}: ${pct}%  "${e.text}"`)
          t.ok(
            wer <= WER_THRESHOLD,
            `parler ${variant} WER ${pct}% <= ${(WER_THRESHOLD * 100).toFixed(0)}% for "${e.text}"`
          )
        }
      } finally {
        await whisper.unload()
      }
    }
  )
}
