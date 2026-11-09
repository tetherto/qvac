import test from 'brittle'
import os from 'bare-os'
import { AudioGen, ENGINE_ACESTEP, ENGINE_MINIMAX } from '@qvac/audiogen-ggml'
import { ModelLoadFailedError } from '@/errors/index'
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

test('AudioGen rejects MiniMax on mobile before resolving model paths', async (t) => {
  let resolveCalls = 0
  const context: ResolveContext = {
    modelSrc: '',
    modelType: 'audiogen-ggml',
    platform: 'ios',
    resolveModelPath: async function () {
      resolveCalls++
      return '/resolved/model.gguf'
    }
  }

  await t.exception(
    () =>
      resolveAudioGenConfig(
        {
          engine: 'minimax',
          lmModelSrc: 'minimax-lm.gguf',
          synthModelSrc: 'minimax-synth.gguf'
        },
        context
      ),
    ModelLoadFailedError
  )
  t.is(resolveCalls, 0, 'the platform guard runs before either model download')
})

test('AudioGen plugin defaults to ACE-Step and forwards all four artifacts', (t) => {
  const result = audioGenPlugin.createModel({
    modelId: 'acestep-model',
    modelPath: '',
    modelConfig: { useGPU: false },
    artifacts: {
      textEncModelPath: '/resolved/text-encoder.gguf',
      lmModelPath: '/resolved/lm.gguf',
      ditModelPath: '/resolved/dit.gguf',
      vaeModelPath: '/resolved/vae.gguf'
    }
  })
  const internals = result.model as unknown as {
    _engineType: string
    _configuration: {
      textEncModelPath?: string
      lmModelPath?: string
      ditModelPath?: string
      vaeModelPath?: string
    }
  }

  t.is(internals._engineType, ENGINE_ACESTEP)
  t.is(internals._configuration.textEncModelPath, '/resolved/text-encoder.gguf')
  t.is(internals._configuration.lmModelPath, '/resolved/lm.gguf')
  t.is(internals._configuration.ditModelPath, '/resolved/dit.gguf')
  t.is(internals._configuration.vaeModelPath, '/resolved/vae.gguf')
})

test('AudioGen plugin hands the ACE-Step backends and stage dump directory to the engine', async (t) => {
  const context: ResolveContext = {
    modelSrc: '',
    modelType: 'audiogen-ggml',
    resolveModelPath: async function (source) {
      return `/resolved/${typeof source === 'string' ? source : source.src}`
    }
  }
  const placement = { backend: 'CUDA0', lmBackend: 'cpu', dumpStagesDir: '/tmp/acestep-stages' }
  const resolved = await resolveAudioGenConfig(
    {
      textEncModelSrc: 'text-encoder.gguf',
      lmModelSrc: 'lm.gguf',
      ditModelSrc: 'dit.gguf',
      vaeModelSrc: 'vae.gguf',
      useGPU: true,
      ...placement
    },
    context
  )
  t.alike(resolved.config, { useGPU: true, ...placement })

  const result = audioGenPlugin.createModel({
    modelId: 'acestep-placement-model',
    modelPath: '',
    modelConfig: resolved.config,
    artifacts: resolved.artifacts
  })
  const internals = result.model as unknown as {
    _configuration: { backend?: string; lmBackend?: string; dumpStagesDir?: string }
  }
  t.is(internals._configuration.backend, 'CUDA0')
  t.is(internals._configuration.lmBackend, 'cpu')
  t.is(internals._configuration.dumpStagesDir, '/tmp/acestep-stages')
})

test('AudioGen plugin rejects incomplete ACE-Step artifacts', (t) => {
  t.exception(
    () =>
      audioGenPlugin.createModel({
        modelId: 'incomplete-acestep-model',
        modelPath: '',
        modelConfig: {},
        artifacts: {
          textEncModelPath: '/resolved/text-encoder.gguf',
          lmModelPath: '/resolved/lm.gguf',
          ditModelPath: '/resolved/dit.gguf'
        }
      }),
    ModelLoadFailedError
  )
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

test('AudioGen plugin hands the MiniMax device to the engine', async (t) => {
  const context: ResolveContext = {
    modelSrc: '',
    modelType: 'audiogen-ggml',
    resolveModelPath: async function (source) {
      return `/resolved/${typeof source === 'string' ? source : source.src}`
    }
  }
  const resolved = await resolveAudioGenConfig(
    {
      engine: 'minimax',
      lmModelSrc: 'minimax-lm.gguf',
      synthModelSrc: 'minimax-synth.gguf',
      device: 'gpu'
    },
    context
  )
  t.alike(resolved.config, { engine: 'minimax', device: 'gpu' })

  const result = audioGenPlugin.createModel({
    modelId: 'minimax-gpu-model',
    modelPath: '',
    modelConfig: resolved.config,
    artifacts: resolved.artifacts
  })
  const internals = result.model as unknown as {
    _configuration: { device?: string; useGPU?: boolean }
  }
  t.is(internals._configuration.device, 'gpu', 'a GPU-less host fails the load instead')
  t.is(internals._configuration.useGPU, false, 'the addon reads device ahead of the switch')
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

const MINIMAX_COREML = {
  engine: 'minimax',
  lmModelSrc: 'minimax-lm.gguf',
  synthModelSrc: 'minimax-synth.gguf',
  coremlProfileDir: '/models/minimax-coreml',
  coremlComputeUnits: 'CPU_AND_NE'
}

test('AudioGen rejects MiniMax Core ML off macOS before resolving model paths', async (t) => {
  for (const platform of ['linux', 'win32'] as const) {
    let resolveCalls = 0
    const context: ResolveContext = {
      modelSrc: '',
      modelType: 'audiogen-ggml',
      platform,
      resolveModelPath: async function () {
        resolveCalls++
        return '/resolved/model.gguf'
      }
    }
    await t.exception(() => resolveAudioGenConfig(MINIMAX_COREML, context), ModelLoadFailedError)
    t.is(resolveCalls, 0, `${platform}: the guard runs before either model download`)
  }
})

test('AudioGen plugin hands the MiniMax Core ML profile to the engine', async (t) => {
  const context: ResolveContext = {
    modelSrc: '',
    modelType: 'audiogen-ggml',
    platform: 'darwin',
    resolveModelPath: async function (source) {
      return `/resolved/${typeof source === 'string' ? source : source.src}`
    }
  }
  const resolved = await resolveAudioGenConfig(MINIMAX_COREML, context)
  t.alike(resolved.config, {
    engine: 'minimax',
    coremlProfileDir: '/models/minimax-coreml',
    coremlComputeUnits: 'CPU_AND_NE'
  })

  const create = () =>
    audioGenPlugin.createModel({
      modelId: 'minimax-coreml-model',
      modelPath: '',
      modelConfig: resolved.config,
      artifacts: resolved.artifacts
    })
  // The addon checks the host itself, so what a host sees depends on where
  // this runs: macOS builds the engine config, anything else is refused.
  if (os.platform() !== 'darwin') {
    t.exception(create, /MiniMax Core ML requires macOS/)
    return
  }
  const internals = create().model as unknown as {
    _configuration: { coremlProfileDir?: string; coremlComputeUnits?: string }
  }
  t.is(internals._configuration.coremlProfileDir, '/models/minimax-coreml')
  t.is(internals._configuration.coremlComputeUnits, 'CPU_AND_NE')
})

const MINIMAX_CONDITIONER = {
  engine: 'minimax',
  lmModelSrc: 'minimax-lm.gguf',
  synthModelSrc: 'minimax-synth.gguf',
  device: 'gpu',
  coremlConditionerPath: '/models/minimax-conditioner.mlmodelc'
}

test('AudioGen rejects the MiniMax Core ML conditioner off macOS before resolving model paths', async (t) => {
  for (const platform of ['linux', 'win32'] as const) {
    let resolveCalls = 0
    const context: ResolveContext = {
      modelSrc: '',
      modelType: 'audiogen-ggml',
      platform,
      resolveModelPath: async function () {
        resolveCalls++
        return '/resolved/model.gguf'
      }
    }
    await t.exception(
      () => resolveAudioGenConfig(MINIMAX_CONDITIONER, context),
      /Core ML conditioner requires macOS/
    )
    t.is(resolveCalls, 0, `${platform}: the guard runs before either model download`)
  }
})

test('AudioGen plugin hands the MiniMax Core ML conditioner to the engine', async (t) => {
  const context: ResolveContext = {
    modelSrc: '',
    modelType: 'audiogen-ggml',
    platform: 'darwin',
    resolveModelPath: async function (source) {
      return `/resolved/${typeof source === 'string' ? source : source.src}`
    }
  }
  const resolved = await resolveAudioGenConfig(MINIMAX_CONDITIONER, context)
  t.alike(resolved.config, {
    engine: 'minimax',
    device: 'gpu',
    coremlConditionerPath: '/models/minimax-conditioner.mlmodelc'
  })

  // The conditioner leaves the other stages where `device` puts them, and the
  // addon checks the bundle natively at load, so the engine config builds on
  // any host.
  const result = audioGenPlugin.createModel({
    modelId: 'minimax-conditioner-model',
    modelPath: '',
    modelConfig: resolved.config,
    artifacts: resolved.artifacts
  })
  const internals = result.model as unknown as {
    _configuration: { coremlConditionerPath?: string; coremlProfileDir?: string; device?: string }
  }
  t.is(internals._configuration.coremlConditionerPath, '/models/minimax-conditioner.mlmodelc')
  t.is(internals._configuration.coremlProfileDir, undefined, 'the full profile stays off')
  t.is(internals._configuration.device, 'gpu')
})
