import {
  loadModel,
  textToSpeech,
  unloadModel,
  type ModelProgressUpdate,
  TTS_LM_MULTILINGUAL_AUDIO8_Q8_0,
  TTS_CODEC_DECODER_AUDIO8_Q8_0
} from '@qvac/sdk'
import { createWav, playAudio, int16ArrayToBuffer, createWavHeader } from './utils'

// Audio8 (GGML): DualAR LM + codec decoder, native 44.1 kHz output. The
// primary modelSrc is the LM GGUF; the codec decoder loads via modelConfig.
// For zero-shot voice cloning also pass audio8CodecEncoderModelSrc plus
// referenceAudioSrc/referenceText (a recording and its exact transcript).
const AUDIO8_SAMPLE_RATE = 44100

try {
  const modelId = await loadModel({
    modelSrc: TTS_LM_MULTILINGUAL_AUDIO8_Q8_0,
    modelConfig: {
      ttsEngine: 'audio8',
      audio8CodecDecoderModelSrc: TTS_CODEC_DECODER_AUDIO8_Q8_0,
      temperature: 0.7,
      topP: 0.9,
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

  console.log('▸ Testing Audio8 Text-to-Speech...')
  const result = textToSpeech({
    modelId,
    text: 'Hey, how are you doing today?',
    inputType: 'text',
    stream: false
  })

  const audioBuffer = await result.buffer
  console.log(`▸ TTS complete. Total samples: ${audioBuffer.length}`)

  console.log('▸ Saving audio to file...')
  createWav(audioBuffer, AUDIO8_SAMPLE_RATE, 'audio8-output.wav')
  console.log('▸ Audio saved to audio8-output.wav')

  console.log('▸ Playing audio...')
  const audioData = int16ArrayToBuffer(audioBuffer)
  const wavBuffer = Buffer.concat([
    createWavHeader(audioData.length, AUDIO8_SAMPLE_RATE),
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
