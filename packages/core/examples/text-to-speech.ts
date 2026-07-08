// Text-to-speech with Chatterbox (GGML). Writes raw 24 kHz mono PCM to
// output.pcm.
//
// Run: bare examples/text-to-speech.ts
// Requires: npm install @qvac/core @qvac/tts-ggml

import fs from 'bare-fs'
import Buffer from 'bare-buffer'
import {
  registerPlugin,
  loadModel,
  textToSpeech,
  unloadModel,
  TTS_T3_TURBO_EN_CHATTERBOX_Q8_0,
  TTS_S3GEN_EN_CHATTERBOX
} from '@qvac/core'
import { ttsPlugin } from '@qvac/core/tts-ggml/plugin'

registerPlugin(ttsPlugin)

try {
  const modelId = await loadModel({
    modelSrc: TTS_T3_TURBO_EN_CHATTERBOX_Q8_0,
    modelConfig: {
      ttsEngine: 'chatterbox',
      language: 'en',
      s3genModelSrc: TTS_S3GEN_EN_CHATTERBOX.src,
      cfmSteps: 1
    }
  })
  console.log(`▸ Model loaded: ${modelId}`)

  const result = textToSpeech({
    modelId,
    text: 'QVAC core runs inference directly on the Bare runtime.',
    inputType: 'text',
    stream: false
  })
  const samples = await result.buffer
  // Samples are 16-bit signed PCM; pack them little-endian and write raw.
  const pcm = Buffer.from(Int16Array.from(samples).buffer)
  fs.writeFileSync('output.pcm', pcm)
  console.log(`▸ Wrote output.pcm (${pcm.length} bytes, 24 kHz mono 16-bit PCM)`)

  await unloadModel({ modelId, autoClose: true })
} catch (error) {
  console.error('✖', error)
}
