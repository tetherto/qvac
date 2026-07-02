// Speech-to-text with whisper.cpp. Pass a 16 kHz mono WAV file.
//
// Run: bare examples/transcribe.ts <wav-file>
// Requires: npm install @qvac/core @qvac/transcription-whispercpp

import { registerPlugin, loadModel, transcribe, unloadModel, WHISPER_TINY } from '@qvac/core'
import { whisperPlugin } from '@qvac/core/whispercpp-transcription/plugin'

registerPlugin(whisperPlugin)

const audioPath = Bare.argv.slice(2)[0]
if (!audioPath) {
  console.error('Usage: bare examples/transcribe.ts <wav-file>')
} else {
  try {
    const modelId = await loadModel({
      modelSrc: WHISPER_TINY,
      modelConfig: { language: 'en' }
    })
    console.log(`▸ Model loaded: ${modelId}`)

    const result = await transcribe({ modelId, audioChunk: audioPath })
    console.log(result)

    await unloadModel({ modelId, autoClose: true })
  } catch (error) {
    console.error('✖', error)
  }
}
