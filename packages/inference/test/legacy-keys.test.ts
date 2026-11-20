import test from 'brittle'
import {
  createLegacyKeyWarner,
  renameLegacyConfigKeys,
  renameLegacyDiffusionParams,
  renameLegacyKeys,
  renameLegacyRequestKeys,
  renameLegacyVideoParams,
  type LegacyKeySpec
} from '@/schemas/legacy-keys'
import { llmConfigSchema } from '@/schemas/llamacpp-config'
import { sdcppLoadConfigSchema } from '@/schemas/sdcpp-config'
import { requestSchema } from '@/schemas/index'

const spec: LegacyKeySpec = {
  renames: { ctx_size: 'ctxSize', 'batch-size': 'batchSize', vad_params: 'vadParams' },
  nested: {
    vadParams: { renames: { speech_pad_ms: 'speechPadMs' } },
    prompts: { renames: { top_k: 'topK' } }
  }
}

function collectWarnings() {
  const warnings: [string, string][] = []
  const ignored: string[] = []
  return {
    warnings,
    ignored,
    warn: (legacyPath: string, replacementPath: string, valueIgnored = false) => {
      warnings.push([legacyPath, replacementPath])
      if (valueIgnored) ignored.push(legacyPath)
    }
  }
}

test('renameLegacyKeys moves each legacy key to its replacement', (t) => {
  const { warnings, warn } = collectWarnings()
  const renamed = renameLegacyKeys({ ctx_size: 2048, 'batch-size': 512, seed: 1 }, spec, warn)
  t.alike(renamed, { ctxSize: 2048, batchSize: 512, seed: 1 })
  t.alike(warnings, [
    ['ctx_size', 'ctxSize'],
    ['batch-size', 'batchSize']
  ])
})

test('renameLegacyKeys keeps the camelCase value when both spellings are sent', (t) => {
  const { warnings, ignored, warn } = collectWarnings()
  t.alike(renameLegacyKeys({ ctx_size: 1024, ctxSize: 4096 }, spec, warn), { ctxSize: 4096 })
  t.alike(warnings, [['ctx_size', 'ctxSize']])
  t.alike(ignored, ['ctx_size'], 'the warning reports that the legacy value was dropped')
})

test('renameLegacyKeys renames inside a renamed child object', (t) => {
  const { warnings, warn } = collectWarnings()
  const renamed = renameLegacyKeys({ vad_params: { speech_pad_ms: 30 } }, spec, warn, 'modelConfig')
  t.alike(renamed, { vadParams: { speechPadMs: 30 } })
  t.alike(warnings, [
    ['modelConfig.vad_params', 'modelConfig.vadParams'],
    ['modelConfig.vadParams.speech_pad_ms', 'modelConfig.vadParams.speechPadMs']
  ])
})

test('renameLegacyKeys renames every item of a child array', (t) => {
  const { warnings, warn } = collectWarnings()
  const renamed = renameLegacyKeys({ prompts: [{ top_k: 5 }, { topK: 7 }] }, spec, warn)
  t.alike(renamed, { prompts: [{ topK: 5 }, { topK: 7 }] })
  t.alike(warnings, [['prompts[0].top_k', 'prompts[0].topK']])
})

test('renameLegacyKeys returns the input itself when it holds no legacy key', (t) => {
  const { warnings, warn } = collectWarnings()
  const input = { ctxSize: 2048, prompts: [{ topK: 1 }] }
  t.is(renameLegacyKeys(input, spec, warn), input)
  t.is(warnings.length, 0)
})

test('renameLegacyKeys returns a renamed copy and leaves the caller object unchanged', (t) => {
  const input = { ctx_size: 2048, vad_params: { speech_pad_ms: 30 } }
  const before = { ctx_size: 2048, vad_params: { speech_pad_ms: 30 } }
  const renamed = renameLegacyKeys(input, spec, () => {}) as Record<string, unknown>
  t.alike(renamed, { ctxSize: 2048, vadParams: { speechPadMs: 30 } })
  t.not(renamed, input, 'the result is a new object')
  t.not(renamed['vadParams'], input.vad_params, 'nested objects are copied too')
  t.alike(input, before, 'the caller object still holds its legacy keys')
})

test('createLegacyKeyWarner logs each legacy path once, naming the replacement', (t) => {
  const messages: string[] = []
  const warn = createLegacyKeyWarner((message) => messages.push(message))
  warn('prompts[0].top_k', 'prompts[0].topK')
  warn('prompts[1].top_k', 'prompts[1].topK')
  warn('modelConfig.ctx_size', 'modelConfig.ctxSize')
  t.alike(messages, [
    '"prompts[0].top_k" is deprecated and will be removed in the next release. Use "prompts[0].topK" instead.',
    '"modelConfig.ctx_size" is deprecated and will be removed in the next release. Use "modelConfig.ctxSize" instead.'
  ])
})

test('createLegacyKeyWarner says when the deprecated value was ignored', (t) => {
  const messages: string[] = []
  const warn = createLegacyKeyWarner((message) => messages.push(message))
  warn('modelConfig.ctx_size', 'modelConfig.ctxSize', true)
  t.alike(messages, [
    '"modelConfig.ctx_size" is deprecated and will be removed in the next release. Use "modelConfig.ctxSize" instead. Its value was ignored because "modelConfig.ctxSize" is also set.'
  ])
})

test('renameLegacyRequestKeys: an LLM load with legacy keys loads the same config', (t) => {
  const { warnings, warn } = collectWarnings()
  const legacy = {
    'flash-attn': 'on',
    ctx_size: 4096,
    temp: 0.5,
    'main-gpu': 1,
    system_prompt: 'be brief'
  }
  const camelCase = {
    flashAttention: 'on',
    ctxSize: 4096,
    temperature: 0.5,
    mainGpu: 1,
    systemPrompt: 'be brief'
  }
  for (const modelType of ['llamacpp-completion', 'llm']) {
    const renamed = renameLegacyRequestKeys(
      { type: 'loadModel', modelType, modelConfig: legacy },
      warn
    )
    t.alike(llmConfigSchema.parse(renamed.modelConfig), llmConfigSchema.parse(camelCase), modelType)
  }
  t.ok(warnings.some(([legacyPath]) => legacyPath === 'modelConfig.flash-attn'))
})

test('renameLegacyRequestKeys: decision and rerank loads take the shared spellings', (t) => {
  const { warn } = collectWarnings()
  for (const modelType of ['llamacpp-decision', 'llamacpp-rerank']) {
    const renamed = renameLegacyRequestKeys(
      {
        type: 'loadModel',
        modelType,
        modelConfig: { gpu_layers: 10, batch_size: 512, flash_attn: 'off', 'split-mode': 'none' }
      },
      warn
    )
    t.alike(
      renamed.modelConfig,
      { gpuLayers: 10, batchSize: 512, flashAttention: 'off', splitMode: 'none' },
      modelType
    )
  }
})

test('renameLegacyRequestKeys: whisper and BCI nested configs', (t) => {
  const { warn } = collectWarnings()
  const whisper = renameLegacyRequestKeys(
    {
      type: 'loadModel',
      modelType: 'whisper',
      modelConfig: {
        n_threads: 4,
        beam_search_beam_size: 5,
        vad_params: { speech_pad_ms: 30 },
        contextParams: { use_gpu: true, flash_attn: true, 'main-gpu': 'dedicated' },
        miscConfig: { caption_enabled: true }
      }
    },
    warn
  )
  t.alike(whisper.modelConfig, {
    threads: 4,
    beamSize: 5,
    vadParams: { speechPadMs: 30 },
    contextParams: { useGpu: true, flashAttention: true, mainGpu: 'dedicated' },
    miscConfig: { captionEnabled: true }
  })

  const bci = renameLegacyRequestKeys(
    {
      type: 'loadModel',
      modelType: 'bci-whispercpp-transcription',
      modelConfig: {
        whisperConfig: { n_threads: 2, greedy_best_of: 3 },
        bciConfig: { day_idx: 1 },
        contextParams: { gpu_device: 0 }
      }
    },
    warn
  )
  t.alike(bci.modelConfig, {
    whisperConfig: { threads: 2, greedyBestOf: 3 },
    bciConfig: { dayIdx: 1 },
    contextParams: { gpuDevice: 0 }
  })
})

test('renameLegacyRequestKeys: sd.cpp load config and its upscaler block', (t) => {
  const { warn } = collectWarnings()
  const renamed = renameLegacyRequestKeys(
    {
      type: 'loadModel',
      modelType: 'diffusion',
      modelConfig: {
        diffusion_fa: true,
        offload_to_cpu: true,
        'main-gpu': 0,
        upscaler: { model_src: 'esrgan.pth', tile_size: 128, offload_params_to_cpu: true }
      }
    },
    warn
  )
  t.alike(renamed.modelConfig, {
    diffusionFlashAttention: true,
    offloadToCpu: true,
    mainGpu: 0,
    upscaler: { modelSrc: 'esrgan.pth', tileSize: 128, offloadToCpu: true }
  })
})

test('renameLegacyDiffusionParams and renameLegacyVideoParams: client params', (t) => {
  const { warn } = collectWarnings()
  const image = new Uint8Array([1])
  t.alike(
    renameLegacyDiffusionParams(
      { modelId: 'a', prompt: 'p', negative_prompt: 'n', cfg_scale: 4, init_image: image },
      warn
    ),
    { modelId: 'a', prompt: 'p', negativePrompt: 'n', cfgScale: 4, initImage: image }
  )
  t.alike(
    renameLegacyVideoParams(
      { modelId: 'a', prompt: 'p', mode: 'img2vid', init_image: image, video_frames: 17 },
      warn
    ),
    { modelId: 'a', prompt: 'p', mode: 'img2vid', initImage: image, videoFrames: 17 }
  )
})

test('renameLegacyRequestKeys: one spelling for NMT, TTS, audio-gen and OCR', (t) => {
  const { warn } = collectWarnings()
  const load = (modelType: string, modelConfig: Record<string, unknown>) =>
    renameLegacyRequestKeys({ type: 'loadModel', modelType, modelConfig }, warn).modelConfig

  t.alike(
    load('nmt', {
      engine: 'Bergamot',
      beamsize: 2,
      repetitionpenalty: 1.1,
      topk: 5,
      pivotModel: { modelSrc: 'p', norepeatngramsize: 3, topp: 0.9 }
    }),
    {
      engine: 'Bergamot',
      beamSize: 2,
      repeatPenalty: 1.1,
      topK: 5,
      pivotModel: { modelSrc: 'p', noRepeatNgramSize: 3, topP: 0.9 }
    }
  )
  for (const modelType of ['parakeet', 'moss-transcribe', 'tts', 'audiogen']) {
    t.alike(load(modelType, { useGPU: true }), { useGpu: true }, modelType)
  }
  for (const modelType of ['parakeet', 'moss-transcribe']) {
    t.alike(load(modelType, { maxThreads: 4 }), { threads: 4 }, `${modelType} threads`)
  }
  t.alike(load('ocr', { nThreads: 4 }), { threads: 4 })
  t.alike(
    renameLegacyRequestKeys(
      {
        type: 'audioGenStream',
        modelId: 'a',
        caption: 'c',
        keyscale: 'C minor',
        timesignature: '4'
      },
      warn
    ),
    { type: 'audioGenStream', modelId: 'a', caption: 'c', keyScale: 'C minor', timeSignature: '4' }
  )
})

test('renameLegacyRequestKeys: completion generation params and response format', (t) => {
  const { warn } = collectWarnings()
  const request = renameLegacyRequestKeys(
    {
      type: 'completionStream',
      modelId: 'a',
      stream: true,
      history: [{ role: 'user', content: 'hi' }],
      generationParams: { temp: 0, top_k: 1, tool_choice: 'none', parallel_tool_calls: false },
      responseFormat: { type: 'json_schema', json_schema: { name: 'A', schema: {} } }
    },
    warn
  )
  t.alike(request.generationParams, {
    temperature: 0,
    topK: 1,
    toolChoice: 'none',
    parallelToolCalls: false
  })
  t.alike(request.responseFormat, { type: 'json_schema', jsonSchema: { name: 'A', schema: {} } })
  t.ok(requestSchema.safeParse(request).success, 'the renamed request validates')
})

test('renameLegacyRequestKeys: every batch prompt is renamed', (t) => {
  const { warn } = collectWarnings()
  const request = renameLegacyRequestKeys(
    {
      type: 'batchCompletionStream',
      modelId: 'a',
      prompts: [
        { history: [{ role: 'user', content: 'a' }], generationParams: { top_p: 0.5 } },
        { history: [{ role: 'user', content: 'b' }], generationParams: { topP: 0.7 } }
      ]
    },
    warn
  )
  t.alike(
    request.prompts.map((prompt) => prompt.generationParams),
    [{ topP: 0.5 }, { topP: 0.7 }]
  )
})

test('renameLegacyRequestKeys: every assessModelFit candidate is renamed', (t) => {
  const { warnings, warn } = collectWarnings()
  const request = renameLegacyRequestKeys(
    {
      type: 'assessModelFit',
      models: [{ modelSrc: 'a.gguf', modelType: 'llm', modelConfig: { ctx_size: 2048 } }]
    },
    warn
  )
  t.alike(request.models[0]?.modelConfig, { ctxSize: 2048 })
  t.alike(warnings, [['models[0].modelConfig.ctx_size', 'models[0].modelConfig.ctxSize']])
})

test('renameLegacyRequestKeys: an assessModelFit candidate without modelType takes it from modelSrc', (t) => {
  const { warnings, warn } = collectWarnings()
  const request = renameLegacyRequestKeys(
    {
      type: 'assessModelFit',
      models: [
        {
          modelSrc: { src: 'a.gguf', engine: 'llamacpp-completion' },
          modelConfig: { ctx_size: 32768 }
        }
      ]
    },
    warn
  )
  t.alike(request.models[0]?.modelConfig, { ctxSize: 32768 })
  t.alike(warnings, [['models[0].modelConfig.ctx_size', 'models[0].modelConfig.ctxSize']])
})

test('renameLegacyConfigKeys: device defaults under canonical and alias model types', (t) => {
  const { warn } = collectWarnings()
  const config = renameLegacyConfigKeys(
    {
      deviceDefaults: [
        {
          name: 'Pixel',
          match: { platform: 'android' },
          defaults: {
            llm: { gpu_layers: 0 },
            'llamacpp-completion': { 'flash-attn': 'off' }
          }
        }
      ]
    },
    warn
  )
  t.alike(config.deviceDefaults[0]?.defaults, {
    llm: { gpuLayers: 0 },
    'llamacpp-completion': { flashAttention: 'off' }
  })
})

test('renameLegacyRequestKeys: the Core ML FFN keys load a valid LLM config', (t) => {
  const { warnings, warn } = collectWarnings()
  const llm = renameLegacyRequestKeys(
    {
      type: 'loadModel',
      modelType: 'llm',
      modelConfig: {
        'coreml-ffn': true,
        'coreml-ffn-split': '2048x1',
        'coreml-ffn-cache': '/tmp/coreml-ffn'
      }
    },
    warn
  )
  t.alike(llm.modelConfig, {
    coremlFfn: true,
    coremlFfnSplit: '2048x1',
    coremlFfnCache: '/tmp/coreml-ffn'
  })
  t.ok(llmConfigSchema.safeParse(llm.modelConfig).success)
  t.ok(warnings.some(([legacyPath]) => legacyPath === 'modelConfig.coreml-ffn-split'))
})

test('renameLegacyRequestKeys: the sd.cpp performance keys load a valid config', (t) => {
  const { warnings, warn } = collectWarnings()
  const sdcpp = renameLegacyRequestKeys(
    {
      type: 'loadModel',
      modelType: 'diffusion',
      modelConfig: {
        performance_profile: 'off',
        performance_max_width: 768,
        performance_max_height: 512,
        performance_max_frames: 97,
        vae_conv_direct: true,
        tensor_type_rules: '^vae\\.=f16'
      }
    },
    warn
  )
  t.alike(sdcpp.modelConfig, {
    performanceProfile: 'off',
    performanceMaxWidth: 768,
    performanceMaxHeight: 512,
    performanceMaxFrames: 97,
    vaeConvDirect: true,
    tensorTypeRules: '^vae\\.=f16'
  })
  t.ok(sdcppLoadConfigSchema.safeParse(sdcpp.modelConfig).success)
  t.ok(warnings.some(([legacyPath]) => legacyPath === 'modelConfig.tensor_type_rules'))
})
