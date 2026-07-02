// Speech-to-text with Parakeet (a second transcription engine). Pass a
// 16 kHz mono WAV file.
//
// Run: bare examples/parakeet.ts <wav-file>
// Requires: npm install @qvac/core @qvac/transcription-parakeet

import {
  registerPlugin,
  loadModel,
  transcribe,
  unloadModel,
  PARAKEET_CTC_0_6B_Q8_0
} from '@qvac/core'
import { parakeetPlugin } from '@qvac/core/parakeet-transcription/plugin'

registerPlugin(parakeetPlugin)

const audioPath = Bare.argv.slice(2)[0]
if (!audioPath) {
  console.error('Usage: bare examples/parakeet.ts <wav-file>')
} else {
  try {
    const modelId = await loadModel({
      modelSrc: PARAKEET_CTC_0_6B_Q8_0,
      modelType: 'parakeet-transcription'
    })
    console.log(`▸ Model loaded: ${modelId}`)

    const result = await transcribe({ modelId, audioChunk: audioPath })
    console.log(result)

    await unloadModel({ modelId, autoClose: true })
  } catch (error) {
    console.error('✖', error)
  }
}
