import test from 'brittle'
import env from 'bare-env'
import fs from 'bare-fs'
import path from 'bare-path'
import os from 'bare-os'
import { loadModel } from '@/api/load-model'
import { unloadModel } from '@/api/unload-model'
import { textToSpeech } from '@/api/text-to-speech'
import { stream, close } from '@/dispatch'
import { registerPlugin } from '@/plugins/registry'
import { setConfig } from '@/runtime/state'
import { ttsPlugin } from '@/plugins/builtin/tts-ggml/plugin'
import {
  TTS_COSYVOICE3_LLM_COSYVOICE_Q4_0,
  TTS_COSYVOICE3_LLM_COSYVOICE_Q8_0,
  getModelByPath
} from '@/models/registry'
import { getCompanionSetCacheDir } from '@/utils/cache/paths'

// Real registry downloads and native inference, deliberately separate from the
// offline unit lane. Run after build:test with QVAC_TEST_COSYVOICE=1.
const enabled = env['QVAC_TEST_COSYVOICE'] === '1'
if (enabled) {
  setConfig({
    cacheDirectory: path.join(os.tmpdir(), 'qvac-cosyvoice-registry-validation'),
    loggerConsoleOutput: true,
    loggerLevel: 'info'
  })
}

const text =
  'Hello from CosyVoice with this smaller model speaking locally with clear and natural audio.'

for (const descriptor of [TTS_COSYVOICE3_LLM_COSYVOICE_Q4_0, TTS_COSYVOICE3_LLM_COSYVOICE_Q8_0]) {
  test(
    `CosyVoice3 registry: ${descriptor.name} loads, synthesizes and streams natively`,
    { skip: !enabled, timeout: 1_800_000 },
    async (t) => {
      registerPlugin(ttsPlugin)
      try {
        for (const nativeStream of [false, true]) {
          const modelId = await loadModel({
            modelSrc: descriptor,
            modelType: 'tts-ggml',
            modelConfig: {
              ttsEngine: 'cosyvoice3',
              useGPU: true,
              seed: 42,
              ...(nativeStream ? { streamChunkTokens: 25, streamFirstChunkTokens: 25 } : {})
            }
          })
          try {
            const set = getModelByPath(descriptor.registryPath)!.companionSet!
            const dir = getCompanionSetCacheDir(set.setKey)
            for (const file of set.files) {
              t.is(
                fs.statSync(path.join(dir, file.targetName)).size,
                file.expectedSize,
                `${file.targetName} was resolved into the companion cache`
              )
            }
            let samples: number[] = []
            if (!nativeStream) {
              const result = textToSpeech({ modelId, text, stream: false })
              samples = await result.buffer
              t.is(await result.sampleRate, 24000)
              t.is(await result.stopReason, 'completed')
            } else {
              let chunks = 0
              let completed = false
              // One text job with native streamChunkTokens configured; no
              // sentence splitting, so multiple PCM frames prove native output.
              for await (const frame of stream({
                type: 'textToSpeech',
                modelId,
                text,
                stream: true
              })) {
                if (frame.type !== 'textToSpeech') continue
                if (frame.buffer.length > 0) {
                  chunks++
                  for (const sample of frame.buffer) samples.push(sample)
                  t.is(frame.sampleRate, 24000)
                  t.is(frame.chunkIndex, 0, 'all native chunks belong to one unsplit sentence')
                }
                if (frame.done) completed = frame.stopReason === 'completed'
              }
              t.ok(chunks > 1, `native stream emitted ${chunks} audio chunks`)
              t.ok(completed, 'native stream completed')
            }
            t.ok(samples.length > 4096, 'synthesis produced substantial audio')
            t.ok(samples.every(Number.isFinite), 'PCM samples are finite')
            t.ok(
              samples.some((sample) => Math.abs(sample) > 1e-4),
              'PCM is non-silent'
            )
            console.log(
              JSON.stringify({ model: descriptor.name, nativeStream, samples: samples.length })
            )
          } finally {
            await unloadModel({ modelId })
          }
        }
      } finally {
        await close()
      }
    }
  )
}
