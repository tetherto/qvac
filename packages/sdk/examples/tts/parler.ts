import {
  loadModel,
  textToSpeech,
  unloadModel,
  type ModelProgressUpdate,
  TTS_MINI_V1_EN_PARLER_TTS_Q8_0
} from '@qvac/sdk'
import { createWav, playAudio, int16ArrayToBuffer, createWavHeader } from './utils'

// Parler-TTS (GGML): description-conditioned speech with per-call voice controls.
// Uses the registry-hosted Mini v1 Q8_0 model and its native 44.1 kHz output.
const PARLER_SAMPLE_RATE = 44100

try {
  const modelId = await loadModel({
    modelSrc: TTS_MINI_V1_EN_PARLER_TTS_Q8_0,
    modelConfig: {
      ttsEngine: 'parler',
      voice: 'Laura',
      seed: 42
    },
    onProgress: (p: ModelProgressUpdate) => {
      const mb = (n: number) => (n / 1e6).toFixed(1)
      const line = `▸ Downloading ${p.percentage.toFixed(0)}% (${mb(p.downloaded)}/${mb(p.total)} MB)`
      process.stderr.write(process.stderr.isTTY ? `\r${line}` : `${line}\n`)
      if (p.percentage >= 100) process.stderr.write('\n')
    }
  })

  console.log(`▸ Model loaded: ${modelId}`)

  console.log('▸ Testing Parler Text-to-Speech...')
  const result = textToSpeech({
    modelId,
    text: 'Hey, how are you doing today?',
    inputType: 'text',
    stream: false,
    emotion: 'happy'
  })

  const audioBuffer = await result.buffer
  console.log(`▸ TTS complete. Total samples: ${audioBuffer.length}`)

  console.log('▸ Saving audio to file...')
  createWav(audioBuffer, PARLER_SAMPLE_RATE, 'parler-output.wav')
  console.log('▸ Audio saved to parler-output.wav')

  console.log('▸ Playing audio...')
  const audioData = int16ArrayToBuffer(audioBuffer)
  const wavBuffer = Buffer.concat([
    createWavHeader(audioData.length, PARLER_SAMPLE_RATE),
    audioData
  ])
  playAudio(wavBuffer)
  console.log('▸ Audio playback complete')

  await unloadModel({ modelId })
  console.log('▸ Model unloaded')
  process.exit(0)
} catch (error) {
  console.error('✖', error)
  process.exit(1)
}
