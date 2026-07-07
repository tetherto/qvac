import {
  loadModel,
  textToSpeech,
  unloadModel,
  type ModelProgressUpdate,
  TTS_MULTILINGUAL_SUPERTONIC3_Q8_0,
  TTS_DENOISER_LAVASR_FP16,
  TTS_ENHANCER_LAVASR_FP16
} from '@qvac/sdk'
import { createWav, playAudio, int16ArrayToBuffer, createWavHeader } from './utils'

// Supertonic 3 TTS (GGML) with LavaSR post-processing: the denoiser cleans the
// synthesized signal first, then the enhancer bandwidth-extends it to 48 kHz.
// Supplying the enhancer GGUF is what enables enhancement — there is no on/off
// flag — and it forces the output to 48 kHz regardless of the engine's native
// rate.
const ENHANCED_SAMPLE_RATE = 48000

try {
  const modelId = await loadModel({
    modelSrc: TTS_MULTILINGUAL_SUPERTONIC3_Q8_0,
    modelConfig: {
      ttsEngine: 'supertonic',
      language: 'en',
      voice: 'F1',
      // Denoiser runs first (rate-preserving)…
      lavasrDenoiserModelSrc: TTS_DENOISER_LAVASR_FP16.src,
      // …then the enhancer bandwidth-extends to 48 kHz.
      lavasrEnhancerModelSrc: TTS_ENHANCER_LAVASR_FP16.src
    },
    onProgress: (p: ModelProgressUpdate) => {
      const mb = (n: number) => (n / 1e6).toFixed(1)
      const line = `▸ Downloading ${p.percentage.toFixed(0)}% (${mb(p.downloaded)}/${mb(p.total)} MB)`
      process.stderr.write(process.stderr.isTTY ? `\r${line}` : `${line}\n`)
      if (p.percentage >= 100) process.stderr.write('\n')
    }
  })

  console.log(`▸ Model loaded: ${modelId}`)

  console.log('▸ Testing Text-to-Speech (LavaSR denoiser + enhancer)...')
  const result = textToSpeech({
    modelId,
    text: `QVAC SDK is the canonical entry point to QVAC. Written in TypeScript, it provides all QVAC capabilities through a unified interface while also abstracting away the complexity of running your application in a JS environment other than Bare. Supported JS environments include Bare, Node.js, Expo and Bun.`,
    inputType: 'text',
    stream: false
  })

  const audioBuffer = await result.buffer
  console.log(`▸ TTS complete. Total samples: ${audioBuffer.length}`)

  console.log('▸ Saving audio to file...')
  createWav(audioBuffer, ENHANCED_SAMPLE_RATE, 'supertonic-enhanced-output.wav')
  console.log('▸ Audio saved to supertonic-enhanced-output.wav')

  console.log('▸ Playing audio...')
  const audioData = int16ArrayToBuffer(audioBuffer)
  const wavBuffer = Buffer.concat([
    createWavHeader(audioData.length, ENHANCED_SAMPLE_RATE),
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
