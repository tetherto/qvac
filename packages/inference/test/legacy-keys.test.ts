import test from 'brittle'
import {
  createLegacyKeyWarner,
  renameLegacyConfigKeys,
  renameLegacyKeys,
  renameLegacyRequestKeys,
  type LegacyKeySpec
} from '@/schemas/legacy-keys'
import { llmConfigSchema } from '@/schemas/llamacpp-config'
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
