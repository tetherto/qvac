// Text-to-speech with Parler-TTS (GGML): description-conditioned speech with
// per-call voice controls. Uses the registry-hosted Mini v1 Q8_0 model and its
// native 44.1 kHz output. Writes raw 44.1 kHz mono PCM to parler-output.pcm.
//
// Run: bare examples/parler.ts
// Requires: npm install @qvac/inference @qvac/tts-ggml

import fs from 'bare-fs'
import Buffer from 'bare-buffer'
import {
  registerPlugin,
  loadModel,
  textToSpeech,
  unloadModel,
  TTS_MINI_V1_EN_PARLER_TTS_Q8_0
} from '@qvac/inference'
import { ttsPlugin } from '@qvac/inference/tts-ggml/plugin'

registerPlugin(ttsPlugin)

const PARLER_SAMPLE_RATE = 44100

try {
  const modelId = await loadModel({
    modelSrc: TTS_MINI_V1_EN_PARLER_TTS_Q8_0,
    modelConfig: {
      ttsEngine: 'parler',
      voice: 'Laura',
      seed: 42
    }
  })
  console.log(`▸ Model loaded: ${modelId}`)

  const result = textToSpeech({
    modelId,
    text: 'Hey, how are you doing today?',
    inputType: 'text',
    stream: false,
    emotion: 'happy'
  })
  const samples = await result.buffer
  // Samples are 16-bit signed PCM; pack them little-endian and write raw.
  const pcm = Buffer.from(Int16Array.from(samples).buffer)
  fs.writeFileSync('parler-output.pcm', pcm)
  console.log(
    `▸ Wrote parler-output.pcm (${pcm.length} bytes, ${PARLER_SAMPLE_RATE / 1000} kHz mono 16-bit PCM)`
  )

  await unloadModel({ modelId, autoClose: true })
} catch (error) {
  console.error('✖', error)
}
