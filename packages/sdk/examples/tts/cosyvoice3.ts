import {
  loadModel,
  textToSpeech,
  unloadModel,
  type ModelProgressUpdate,
  TTS_COSYVOICE3_LLM_COSYVOICE_Q8_0
} from '@qvac/sdk'
import { createWav, playAudio, int16ArrayToBuffer, createWavHeader } from './utils'

// CosyVoice3 (GGML): zero-shot speech with one conditioning control per
// synthesis (emotion, pace, or instruct). The LLM GGUF's registry companion
// set downloads the flow/HiFT models, baked voice and tokenizer alongside it.
// Native output is 24 kHz.
const COSYVOICE3_SAMPLE_RATE = 24000

try {
  const modelId = await loadModel({
    modelSrc: TTS_COSYVOICE3_LLM_COSYVOICE_Q8_0,
    modelConfig: {
      ttsEngine: 'cosyvoice3',
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

  console.log('▸ Testing CosyVoice3 Text-to-Speech...')
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
  createWav(audioBuffer, COSYVOICE3_SAMPLE_RATE, 'cosyvoice3-output.wav')
  console.log('▸ Audio saved to cosyvoice3-output.wav')

  console.log('▸ Playing audio...')
  const audioData = int16ArrayToBuffer(audioBuffer)
  const wavBuffer = Buffer.concat([
    createWavHeader(audioData.length, COSYVOICE3_SAMPLE_RATE),
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
