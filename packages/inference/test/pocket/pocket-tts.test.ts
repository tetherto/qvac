import test from 'brittle'
import { ttsConfigSchema } from '@/schemas/text-to-speech'
import { ttsPlugin } from '@/plugins/builtin/tts-ggml/plugin'
import type TTSGgml from '@qvac/tts-ggml'
import { registerModel, unregisterModel, type AnyModel } from '@/runtime/model-registry'
import { textToSpeech } from '@/plugins/builtin/tts-ggml/ops/text-to-speech'
import { ModelType } from '@/schemas'
import env from 'bare-env'

const bundle = env['QVAC_POCKET_MODEL_DIR']
const loadConfig = (root: string) =>
  ttsConfigSchema.parse({
    ttsEngine: 'pocket',
    mimiModelSrc: root + '/mimi.gguf',
    frontendSrc: root + '/frontend.json',
    voiceSrc: root + '/voice.gguf',
    seed: 4294967295,
    temperature: 0,
    outputSampleRate: 24000
  })

test('Pocket SDK resolves companion descriptors and strips download fields', async (t) => {
  const config = loadConfig('/models/pocket')
  const paths: unknown[] = []
  const result = await ttsPlugin.resolveConfig!(config, {
    resolveModelPath: async (src) => {
      paths.push(src)
      return String(src)
    },
    modelSrc: '/models/pocket/flow-lm.gguf',
    modelType: 'tts-ggml'
  })
  t.is(paths.length, 3)
  t.absent('referenceAudioPath' in (result.artifacts ?? {}))
  t.absent('voiceSrc' in result.config)
  t.absent('mimiModelSrc' in result.config)
  t.absent('frontendSrc' in result.config)
  const { model } = ttsPlugin.createModel({
    modelId: 'pocket-resolve-test',
    modelPath: '/models/pocket/flow-lm.gguf',
    modelConfig: result.config,
    artifacts: result.artifacts as Record<string, string>
  })
  const params = (
    model as unknown as { _buildTtsParams(): Record<string, unknown> }
  )._buildTtsParams()
  t.is(params['pocketMimiModelPath'], '/models/pocket/mimi.gguf')
  t.is(params['pocketFrontendPath'], '/models/pocket/frontend.json')
  t.is(params['pocketVoicePath'], '/models/pocket/voice.gguf')
  t.is(params['seed'], 4294967295)
})

test(
  'Pocket SDK plugin generates real audio through textToSpeech',
  { skip: !bundle },
  async (t) => {
    const root = bundle!
    const modelId = 'pocket-sdk-integration'
    const result = await ttsPlugin.resolveConfig!(loadConfig(root), {
      resolveModelPath: async (src) => String(src),
      modelSrc: root + '/flow-lm.gguf',
      modelType: 'tts-ggml'
    })
    const created = ttsPlugin.createModel({
      modelId,
      modelPath: root + '/flow-lm.gguf',
      modelConfig: result.config,
      artifacts: Object.fromEntries(
        Object.entries(result.artifacts ?? {}).filter(
          (entry): entry is [string, string] => typeof entry[1] === 'string'
        )
      )
    })
    const model = created.model as unknown as TTSGgml
    try {
      await model.load()
      registerModel(modelId, {
        model: created.model as unknown as AnyModel,
        path: root,
        config: result.config,
        modelType: ModelType.ttsGgml
      })
      for (const stream of [false, true]) {
        const synthesis = textToSpeech({
          modelId,
          inputType: 'text',
          type: 'textToSpeech',
          text: 'Hello from Pocket TTS in Fabric.',
          stream,
          sentenceStream: false
        })
        let samples = 0
        let chunks = 0
        let step = await synthesis.next()
        while (!step.done) {
          samples += step.value.buffer.length
          if (step.value.buffer.length) chunks++
          step = await synthesis.next()
        }
        t.ok(samples > 24000)
        t.is(step.value.stats?.totalSamples, samples)
        t.ok(stream ? chunks > 1 : chunks === 1)
      }
    } finally {
      unregisterModel(modelId)
      await model.destroy()
    }
  }
)
