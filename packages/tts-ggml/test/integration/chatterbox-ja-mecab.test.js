'use strict'

// Chatterbox Japanese integration: exercises the MeCab/IPAdic path end
// to end.  Japanese needs word-level morphological segmentation so kanji
// resolve to phonetic readings instead of [UNK]; tts-cpp does the MeCab
// work internally and only needs the compiled dictionary directory via
// EngineOptions::mecab_dict_path.  This test stages that dictionary from
// the QVAC model registry (S3) and forwards it through the addon as
// `files.mecabDictDir`.
//
// Like chatterbox-mtl.test.js this is a coverage smoke, not a GPU policy
// test: it relies on the package default (`useGPU: false`).  It
// skip-as-passes when either the MTL GGUFs or the MeCab dictionary are
// unavailable (no registry access / offline), matching the rest of the
// integration suite.

const fs = require('bare-fs')
const os = require('bare-os')
const path = require('bare-path')
const test = require('brittle')

const TTSGgml = require('@qvac/tts-ggml')
const { runTTS } = require('../utils/runTTS')
const { resolveRefWavPath } = require('../utils/runChatterboxTTS')
const { ensureChatterboxMtlModels, ensureMecabDict } = require('../utils/downloadModel')

const platform = os.platform()
const isMobile = platform === 'ios' || platform === 'android'

function getBaseDir () {
  return isMobile && global.testDir ? global.testDir : '.'
}

const SAMPLE_RATE = 24000

// Mixed kanji + kana so a missing dictionary (character-level fallback)
// would map the kanji to [UNK] and the regression would be audible.
const JA_SENTENCE = '今日はいい天気ですね。'

async function loadChatterboxJaTTS (params) {
  const refWavPath = resolveRefWavPath(params)
  if (!fs.existsSync(refWavPath)) {
    throw new Error('[Chatterbox JA] reference audio not found at ' + refWavPath)
  }

  const model = new TTSGgml({
    files: {
      modelDir: params.modelDir,
      mecabDictDir: params.mecabDictDir
    },
    referenceAudio: refWavPath,
    config: { language: 'ja' },
    opts: { stats: true }
  })
  await model.load()
  return model
}

test('Chatterbox JA TTS (ggml): synthesizes Japanese with MeCab dictionary', { timeout: 1800000 }, async (t) => {
  const baseDir = getBaseDir()

  const download = await ensureChatterboxMtlModels({ targetDir: path.join(baseDir, 'models') })
  if (!download.success) {
    t.pass('Skipped: Chatterbox MTL GGUFs not available')
    return
  }

  const mecab = await ensureMecabDict({ targetDir: path.join(baseDir, 'models', 'mecab-ipadic') })
  if (!mecab.success) {
    t.pass('Skipped: MeCab/IPAdic dictionary not available')
    return
  }

  const model = await loadChatterboxJaTTS({
    modelDir: download.targetDir,
    mecabDictDir: mecab.dir
  })
  try {
    const result = await runTTS(
      model,
      { text: JA_SENTENCE },
      { minSamples: 5000, maxSamples: 5000000, minDurationMs: 200, maxDurationMs: 300000 },
      { sampleRate: SAMPLE_RATE, engineTag: 'Chatterbox JA' }
    )
    console.log('    ' + result.output)

    t.ok(result.passed, 'JA run passes expectations')
    t.ok(result.data.sampleCount > 0, 'JA produced audio')
    t.is(result.data.reportedSampleRate || SAMPLE_RATE, SAMPLE_RATE, 'JA reports 24 kHz')
  } finally {
    try { await model.unload() } catch (_e) {}
  }
})
