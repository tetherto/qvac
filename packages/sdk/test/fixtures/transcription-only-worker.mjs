// Worker for runtime-capabilities.test.ts: the SDK worker with whisper as its
// only plugin, so the capability report differs from the default plugin set.

import { startWorker } from '../../dist/src/worker/start.js'
import { whisperPlugin } from '@qvac/inference/whispercpp-transcription/plugin'

export default function start(ipc, ready) {
  return startWorker(ipc, ready, { plugins: [whisperPlugin] })
}
