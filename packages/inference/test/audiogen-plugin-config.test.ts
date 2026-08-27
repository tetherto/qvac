import test from 'brittle'
import { AudioGen, ENGINE_MINIMAX } from '@qvac/audiogen-ggml'
import { resolveAudioGenConfig } from '@/plugins/builtin/audiogen-ggml/config'
import { audioGenPlugin } from '@/plugins/builtin/audiogen-ggml/plugin'
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

test('AudioGen plugin resolves the MiniMax LM and synthesis sources', async (t) => {
  const resolvedSources: ModelSrcInput[] = []
  const context: ResolveContext = {
    modelSrc: '',
    modelType: 'audiogen-ggml',
    resolveModelPath: async function (source) {
      resolvedSources.push(source)
      return `/resolved/${typeof source === 'string' ? source : source.src}`
    }
  }

  const result = await resolveAudioGenConfig(
    {
      engine: 'minimax',
      lmModelSrc: 'minimax-lm.gguf',
      synthModelSrc: 'minimax-synth.gguf',
      useGPU: true,
      inferenceSteps: 12,
      cfgScale: 1.8
    },
    context
  )

  t.alike(resolvedSources, ['minimax-lm.gguf', 'minimax-synth.gguf'])
  t.alike(result.config, {
    engine: 'minimax',
    useGPU: true,
    inferenceSteps: 12,
    cfgScale: 1.8
  })
  t.alike(result.artifacts, {
    lmModelPath: '/resolved/minimax-lm.gguf',
    synthModelPath: '/resolved/minimax-synth.gguf'
  })
})

test('AudioGen plugin creates a MiniMax engine from resolved artifacts', (t) => {
  const result = audioGenPlugin.createModel({
    modelId: 'minimax-model',
    modelPath: '',
    modelConfig: {
      engine: 'minimax',
      useGPU: false,
      inferenceSteps: 12,
      cfgScale: 1.8
    },
    artifacts: {
      lmModelPath: '/resolved/minimax-lm.gguf',
      synthModelPath: '/resolved/minimax-synth.gguf'
    }
  })
  const model = result.model as AudioGen
  const internals = model as unknown as {
    _engineType: string
    _configuration: {
      lmModelPath?: string
      synthModelPath?: string
      inferenceSteps?: number
      useGPU?: boolean
    }
    _defaultCfgScale: number
  }

  t.is(internals._engineType, ENGINE_MINIMAX)
  t.is(internals._configuration.lmModelPath, '/resolved/minimax-lm.gguf')
  t.is(internals._configuration.synthModelPath, '/resolved/minimax-synth.gguf')
  t.is(internals._configuration.inferenceSteps, undefined)
  t.is(internals._configuration.useGPU, false)
  t.is(internals._defaultCfgScale, 1.8)
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
