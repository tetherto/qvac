// Brain-computer-interface transcription: decode a raw neural-signal file into
// text via the BCI (whisper.cpp) engine.
//
// Run: bare examples/bci-transcribe.ts <neural-bin-file>
// Requires: npm install @qvac/core @qvac/bci-whispercpp

import { registerPlugin, loadModel, bciTranscribe, unloadModel, BCI_WINDOWED } from '@qvac/core'
import { bciPlugin } from '@qvac/core/bci-whispercpp-transcription/plugin'

registerPlugin(bciPlugin)

const neuralPath = Bare.argv.slice(2)[0]
if (!neuralPath) {
  console.error('Usage: bare examples/bci-transcribe.ts <neural-bin-file>')
} else {
  try {
    const modelId = await loadModel({
      modelSrc: BCI_WINDOWED,
      modelConfig: {
        whisperConfig: { language: 'en', n_threads: 4, temperature: 0.0 },
        // day_idx selects the session-specific projection matrices.
        bciConfig: { day_idx: 1 }
      }
    })
    console.log(`▸ Model loaded: ${modelId}`)

    const segments = await bciTranscribe({ modelId, neuralData: neuralPath, metadata: true })
    console.log(segments)

    await unloadModel({ modelId, autoClose: true })
  } catch (error) {
    console.error('✖', error)
  }
}
