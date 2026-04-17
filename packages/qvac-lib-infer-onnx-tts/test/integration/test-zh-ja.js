'use strict'

const test = require('brittle')
const path = require('bare-path')
const { loadChatterboxTTS, runChatterboxTTS } = require('../utils/runChatterboxTTS')
const { ensureChatterboxModels } = require('../utils/downloadModel')

function chatterboxPath (modelDir, baseName) {
  return path.join(modelDir, `${baseName}.onnx`)
}

const TEXT_JA = 'こんにちは世界。今日はいい天気です。'

const EXPECTATION = {
  minSamples: 5000,
  maxSamples: 5000000,
  minDurationMs: 200,
  maxDurationMs: 300000
}

test('Chatterbox: Japanese TTS with kanji (C++ addon)', { timeout: 3600000 }, async (t) => {
  const modelDir = path.join('.', 'models', 'chatterbox-multilingual')
  const outputDir = path.join('.', 'test', 'output', 'addon-reference')

  const downloadResult = await ensureChatterboxModels({ targetDir: modelDir, language: 'multilingual', variant: 'fp32' })
  t.ok(downloadResult.success, 'Models downloaded')
  if (!downloadResult.success) return

  const model = await loadChatterboxTTS({
    tokenizerPath: path.join(modelDir, 'tokenizer.json'),
    speechEncoderPath: chatterboxPath(modelDir, 'speech_encoder'),
    embedTokensPath: chatterboxPath(modelDir, 'embed_tokens'),
    conditionalDecoderPath: chatterboxPath(modelDir, 'conditional_decoder'),
    languageModelPath: chatterboxPath(modelDir, 'language_model'),
    language: 'ja'
  })
  t.ok(model, 'Model loaded')

  console.log(`\nInput text: "${TEXT_JA}"`)
  const wavPath = path.join(outputDir, 'addon-ja.wav')
  const result = await runChatterboxTTS(model, { text: TEXT_JA, saveWav: true, wavOutputPath: wavPath }, EXPECTATION)
  console.log(result.output)

  t.ok(result.passed, '[ja] should pass')
  t.ok(result.data.sampleCount > 0, '[ja] should produce audio')

  await model.unload()
  t.pass('Model unloaded')
})
