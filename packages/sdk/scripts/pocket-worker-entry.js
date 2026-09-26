// Uses the normal SDK worker transport with only the TTS plugin registered.
import { initializeWorker, ensureRPCSetup } from '../dist/src/worker/lifecycle.js'
import { registerPlugin } from '@qvac/inference/plugins'
import { ttsPlugin } from '@qvac/inference/tts-ggml/plugin'
initializeWorker()
registerPlugin(ttsPlugin)
ensureRPCSetup()
