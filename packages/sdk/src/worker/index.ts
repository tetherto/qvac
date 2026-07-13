/**
 * Default worker entry point that registers ALL built-in plugins.
 */

import { initializeWorkerCore, ensureRPCSetup } from '@/server/worker-core'
import { getServerLogger } from '@/logging'
import { registerPlugins } from '@qvac/core/plugins'
import { llmPlugin } from '@qvac/core/llamacpp-completion/plugin'
import { embeddingsPlugin } from '@qvac/core/llamacpp-embedding/plugin'
import { whisperPlugin } from '@qvac/core/whispercpp-transcription/plugin'
import { bciPlugin } from '@qvac/core/bci-whispercpp-transcription/plugin'
import { parakeetPlugin } from '@qvac/core/parakeet-transcription/plugin'
import { nmtPlugin } from '@qvac/core/nmtcpp-translation/plugin'
import { ttsPlugin } from '@qvac/core/tts-ggml/plugin'
import { ocrPlugin } from '@qvac/core/ggml-ocr/plugin'
import { diffusionPlugin } from '@qvac/core/sdcpp-generation/plugin'
import { vlaPlugin } from '@qvac/core/ggml-vla/plugin'
import { classificationPlugin } from '@qvac/core/ggml-classification/plugin'

const { hasRPCConfig } = initializeWorkerCore()

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
