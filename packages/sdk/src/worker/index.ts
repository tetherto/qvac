/**
 * Default worker entry point that registers ALL built-in plugins.
 */

import { initializeWorker, ensureRPCSetup } from '@/worker/lifecycle'
import { getServerLogger } from '@/logging'
import { registerPlugins } from '@qvac/inference/plugins'
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

const { hasRPCConfig } = initializeWorker()

const logger = getServerLogger()

logger.info('🐻 Hello from Bare')

registerPlugins([
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
])

logger.info(
  hasRPCConfig
    ? 'Parsed RPC configuration from arguments'
    : 'Using default configuration (direct mode)'
)

// Auto-setup RPC only if we successfully parsed RPC configuration
if (hasRPCConfig) {
  ensureRPCSetup()
} else {
  logger.info('Running in direct mode - RPC setup will be lazy')
}
