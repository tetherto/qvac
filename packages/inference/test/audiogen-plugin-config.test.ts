import test from 'brittle'
import { resolveAudioGenConfig } from '@/plugins/builtin/audiogen-ggml/config'
import { ModelType, type ModelSrcInput, type ResolveContext } from '@/schemas'
import { resolveModelConfigWithContext } from '@/runtime/model-config-utils'

test('AudioGen plugin resolves all config-owned model sources', async (t) => {
  const resolvedSources: ModelSrcInput[] = []
  let activeResolutions = 0
  let maxActiveResolutions = 0
  const context: ResolveContext = {
    modelSrc: '',
    modelType: 'audiogen-ggml',
    resolveModelPath: async function (source) {
      activeResolutions++
      maxActiveResolutions = Math.max(maxActiveResolutions, activeResolutions)
      await new Promise<void>((resolve) => setTimeout(resolve, 1))
      resolvedSources.push(source)
      activeResolutions--
      return `/resolved/${typeof source === 'string' ? source : source.src}`
    }
  }

  const result = await resolveAudioGenConfig(
    {
      textEncModelSrc: 'text-encoder.gguf',
      lmModelSrc: 'lm.gguf',
      ditModelSrc: 'dit.gguf',
      vaeModelSrc: 'vae.gguf',
      useGPU: true,
      inferenceSteps: 8
    },
    context
  )

  t.alike(resolvedSources, ['text-encoder.gguf', 'lm.gguf', 'dit.gguf', 'vae.gguf'])
  t.is(maxActiveResolutions, 1, 'large AudioGen artifacts resolve sequentially')
  t.alike(result.config, { useGPU: true, inferenceSteps: 8 })
  t.alike(result.artifacts, {
    textEncModelPath: '/resolved/text-encoder.gguf',
    lmModelPath: '/resolved/lm.gguf',
    ditModelPath: '/resolved/dit.gguf',
    vaeModelPath: '/resolved/vae.gguf'
  })
})

test('AudioGen load config survives device-default resolution', (t) => {
  const config = {
    textEncModelSrc: 'text-encoder.gguf',
    lmModelSrc: 'lm.gguf',
    ditModelSrc: 'dit.gguf',
    vaeModelSrc: 'vae.gguf',
    useGPU: true
  }
  const resolved = resolveModelConfigWithContext(
    ModelType.audiogenGgml,
    config,
    { runtime: 'bare', platform: 'darwin' },
    []
  )

  t.alike(resolved, config)
})
