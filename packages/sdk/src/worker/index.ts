import type { Duplex } from 'bare-stream'
import { startWorker } from '@/worker/start'
import { llmPlugin } from '@qvac/inference/llamacpp-completion/plugin'
import { embeddingsPlugin } from '@qvac/inference/llamacpp-embedding/plugin'
import { whisperPlugin } from '@qvac/inference/whispercpp-transcription/plugin'
import { bciPlugin } from '@qvac/inference/bci-whispercpp-transcription/plugin'
import { parakeetPlugin } from '@qvac/inference/parakeet-transcription/plugin'
import { nmtPlugin } from '@qvac/inference/nmtcpp-translation/plugin'
import { ttsPlugin } from '@qvac/inference/tts-ggml/plugin'
import { ocrPlugin } from '@qvac/inference/ggml-ocr/plugin'
import { diffusionPlugin } from '@qvac/inference/sdcpp-generation/plugin'
import { audioGenPlugin } from '@qvac/inference/audiogen-ggml/plugin'
import { vlaPlugin } from '@qvac/inference/ggml-vla/plugin'
import { classificationPlugin } from '@qvac/inference/ggml-classification/plugin'

export default function start(ipc: Duplex, ready: () => void) {
  return startWorker(ipc, ready, {
    plugins: [
      llmPlugin,
      embeddingsPlugin,
      whisperPlugin,
      bciPlugin,
      parakeetPlugin,
      nmtPlugin,
      ttsPlugin,
      ocrPlugin,
      diffusionPlugin,
      audioGenPlugin,
      vlaPlugin,
      classificationPlugin
    ]
  })
}
