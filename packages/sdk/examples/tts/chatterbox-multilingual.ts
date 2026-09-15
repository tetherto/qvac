import {
  loadModel,
  textToSpeech,
  unloadModel,
  type ModelProgressUpdate,
  TTS_T3_MULTILINGUAL_CHATTERBOX_Q4_0,
  TTS_S3GEN_MULTILINGUAL_CHATTERBOX_Q4_0,
  TTS_MECAB_IPADIC_CHATTERBOX
} from '@qvac/sdk'
import { createWav, playAudio, int16ArrayToBuffer, createWavHeader } from './utils'

// Chatterbox multilingual TTS (GGML): Japanese synthesis with MeCab/IPAdic.
// Uses registry model constants — downloads automatically from QVAC Registry.
// Only a fallback: the engine reports the rate it actually produced, and
// `outputSampleRate` (plus the LavaSR enhancer) can move it off this default.
const CHATTERBOX_SAMPLE_RATE = 24000
const OUTPUT_FILE = 'chatterbox-multilingual-output.wav'

try {
  const modelId = await loadModel({
    modelSrc: TTS_T3_MULTILINGUAL_CHATTERBOX_Q4_0,
    modelConfig: {
      ttsEngine: 'chatterbox',
      language: 'ja',
      s3genModelSrc: TTS_S3GEN_MULTILINGUAL_CHATTERBOX_Q4_0,
      mecabDictSrc: TTS_MECAB_IPADIC_CHATTERBOX, //Optional: Only needed for Japanese synthesis
      cfmSteps: 1,
      threads: 8
    },
    onProgress: (p: ModelProgressUpdate) => {
      const mb = (n: number) => (n / 1e6).toFixed(1)
      const line = `▸ Downloading ${p.percentage.toFixed(0)}% (${mb(p.downloaded)}/${mb(p.total)} MB)`
      process.stderr.write(process.stderr.isTTY ? `\r${line}` : `${line}\n`)
      if (p.percentage >= 100) process.stderr.write('\n')
    }
  })

  console.log(`▸ Model loaded: ${modelId}`)

  console.log('▸ Testing Japanese Text-to-Speech...')
  const result = textToSpeech({
    modelId,
    text: 'こんにちは。これはQVAC SDKを使った日本語音声合成のテストです。',
    inputType: 'text',
    stream: false
  })

  const audioBuffer = await result.buffer
  const sampleRate = (await result.sampleRate) ?? CHATTERBOX_SAMPLE_RATE
  console.log(`▸ TTS complete. Total samples: ${audioBuffer.length}`)

  console.log('▸ Saving audio to file...')
  createWav(audioBuffer, sampleRate, OUTPUT_FILE)
  console.log(`▸ Audio saved to ${OUTPUT_FILE}`)

  console.log('▸ Playing audio...')
  const audioData = int16ArrayToBuffer(audioBuffer)
  const wavBuffer = Buffer.concat([createWavHeader(audioData.length, sampleRate), audioData])
  playAudio(wavBuffer)
  console.log('▸ Audio playback complete')

  await unloadModel({ modelId })
  console.log('▸ Model unloaded')
  process.exit(0)
} catch (error) {
  console.error('✖', error)
  process.exit(1)
}
