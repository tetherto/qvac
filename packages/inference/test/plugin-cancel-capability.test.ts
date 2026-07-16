import test from 'brittle'
import { z } from 'zod'
import {
  defineHandler,
  defineDuplexHandler,
  pluginHandlerDefinitionRuntimeSchema,
  type PluginHandlerCancel
} from '../src/schemas/plugin'

// -----------------------------------------------------------------------------
// Plugin cancel-capability contract.
//
// Two halves:
//   - Runtime schema + defineHandler/defineDuplexHandler: the runtime-agnostic
//     shape of the `cancel` field — optional, every valid `scope`, invalid
//     scopes rejected, and the field threaded through the define helpers
//     unmodified.
//   - Built-in plugin truth table: every built-in plugin manifest carries the
//     expected cancel value for its addon's cancel surface, guarding against a
//     manifest tweak that forgets to keep `cancel` in sync with the addon
//     (e.g. adding a hard-cancel call to nmtcpp without flipping its
//     declaration off `"none"`). The truth-table half imports N-API addon
//     bindings, so the whole file runs under the Bare runtime.
// -----------------------------------------------------------------------------

// =============================================================================
// Runtime schema + define helpers
// =============================================================================

test('pluginHandlerDefinitionRuntimeSchema: cancel field is optional', (t) => {
  const withoutCancel = pluginHandlerDefinitionRuntimeSchema.safeParse({
    requestSchema: { safeParse: () => {} },
    responseSchema: { safeParse: () => {} },
    streaming: true,
    handler: () => {}
  })
  t.ok(withoutCancel.success, 'handler without cancel field is valid')
})

test('pluginHandlerDefinitionRuntimeSchema: accepts each cancel.scope value', (t) => {
  const scopes: PluginHandlerCancel['scope'][] = ['request', 'model', 'none']
  for (const scope of scopes) {
    const result = pluginHandlerDefinitionRuntimeSchema.safeParse({
      requestSchema: { safeParse: () => {} },
      responseSchema: { safeParse: () => {} },
      streaming: false,
      handler: () => {},
      cancel: { scope }
    })
    t.ok(result.success, `cancel.scope='${scope}' is valid`)
  }
})

test('pluginHandlerDefinitionRuntimeSchema: cancel.hard is optional and boolean', (t) => {
  const withHardTrue = pluginHandlerDefinitionRuntimeSchema.safeParse({
    requestSchema: { safeParse: () => {} },
    responseSchema: { safeParse: () => {} },
    streaming: false,
    handler: () => {},
    cancel: { scope: 'model', hard: true }
  })
  t.ok(withHardTrue.success, 'hard:true is valid')

  const withHardFalse = pluginHandlerDefinitionRuntimeSchema.safeParse({
    requestSchema: { safeParse: () => {} },
    responseSchema: { safeParse: () => {} },
    streaming: false,
    handler: () => {},
    cancel: { scope: 'model', hard: false }
  })
  t.ok(withHardFalse.success, 'hard:false is valid')

  const withoutHard = pluginHandlerDefinitionRuntimeSchema.safeParse({
    requestSchema: { safeParse: () => {} },
    responseSchema: { safeParse: () => {} },
    streaming: false,
    handler: () => {},
    cancel: { scope: 'none' }
  })
  t.ok(withoutHard.success, 'hard omitted is valid')
})

test('pluginHandlerDefinitionRuntimeSchema: rejects invalid cancel.scope', (t) => {
  const result = pluginHandlerDefinitionRuntimeSchema.safeParse({
    requestSchema: { safeParse: () => {} },
    responseSchema: { safeParse: () => {} },
    streaming: false,
    handler: () => {},
    cancel: { scope: 'everywhere' }
  })
  t.is(result.success, false, 'invalid scope is rejected')
})

test('defineHandler: preserves cancel field on the returned definition', (t) => {
  const def = defineHandler({
    requestSchema: z.object({ modelId: z.string() }),
    responseSchema: z.object({ ok: z.boolean() }),
    streaming: false,
    handler: async () => ({ ok: true }),
    cancel: { scope: 'model', hard: true }
  })
  t.alike(def.cancel, { scope: 'model', hard: true })
})

test('defineDuplexHandler: preserves cancel field on the returned definition', (t) => {
  const def = defineDuplexHandler({
    requestSchema: z.object({ modelId: z.string() }),
    responseSchema: z.object({ ok: z.boolean() }),
    streaming: true,
    duplex: true,
    handler: async function* () {
      yield { ok: true }
    },
    cancel: { scope: 'none' }
  })
  t.alike(def.cancel, { scope: 'none' })
})

// =============================================================================
// Built-in plugin truth table (Bare runtime — N-API addon bindings)
// =============================================================================

test('builtin plugins: every handler declares cancel matching the truth table', async (t) => {
  const [
    { llmPlugin },
    { embeddingsPlugin },
    { whisperPlugin },
    { parakeetPlugin },
    { nmtPlugin },
    { ttsPlugin },
    { ocrPlugin },
    { diffusionPlugin },
    { vlaPlugin },
    { classificationPlugin }
  ] = await Promise.all([
    import('../src/plugins/builtin/llamacpp-completion/plugin'),
    import('../src/plugins/builtin/llamacpp-embedding/plugin'),
    import('../src/plugins/builtin/whispercpp-transcription/plugin'),
    import('../src/plugins/builtin/parakeet-transcription/plugin'),
    import('../src/plugins/builtin/nmtcpp-translation/plugin'),
    import('../src/plugins/builtin/tts-ggml/plugin'),
    import('../src/plugins/builtin/ggml-ocr/plugin'),
    import('../src/plugins/builtin/sdcpp-generation/plugin'),
    import('../src/plugins/builtin/ggml-vla/plugin'),
    import('../src/plugins/builtin/ggml-classification/plugin')
  ])

  const truthTable: Record<string, Record<string, PluginHandlerCancel>> = {
    [llmPlugin.modelType]: {
      completionStream: { scope: 'model', hard: true },
      finetune: { scope: 'model', hard: true },
      translate: { scope: 'model', hard: true }
    },
    [embeddingsPlugin.modelType]: {
      embed: { scope: 'model', hard: true }
    },
    [whisperPlugin.modelType]: {
      transcribe: { scope: 'model', hard: true },
      transcribeStream: { scope: 'model', hard: true }
    },
    [parakeetPlugin.modelType]: {
      transcribe: { scope: 'model', hard: true },
      transcribeStream: { scope: 'model', hard: true }
    },
    [nmtPlugin.modelType]: {
      translate: { scope: 'none' }
    },
    [ttsPlugin.modelType]: {
      textToSpeech: { scope: 'model', hard: true },
      textToSpeechStream: { scope: 'model', hard: true }
    },
    [ocrPlugin.modelType]: {
      ocrStream: { scope: 'none' }
    },
    [diffusionPlugin.modelType]: {
      diffusionStream: { scope: 'model', hard: true },
      videoStream: { scope: 'model', hard: true },
      upscaleStream: { scope: 'none' }
    },
    [vlaPlugin.modelType]: {
      vlaRun: { scope: 'model', hard: true },
      vlaHparams: { scope: 'none' }
    },
    [classificationPlugin.modelType]: {
      classify: { scope: 'none' }
    }
  }

  type BuiltinPlugin = {
    modelType: string
    handlers: Record<string, { cancel?: PluginHandlerCancel } & Record<string, unknown>>
  }

  const builtins: BuiltinPlugin[] = [
    llmPlugin as unknown as BuiltinPlugin,
    embeddingsPlugin as unknown as BuiltinPlugin,
    whisperPlugin as unknown as BuiltinPlugin,
    parakeetPlugin as unknown as BuiltinPlugin,
    nmtPlugin as unknown as BuiltinPlugin,
    ttsPlugin as unknown as BuiltinPlugin,
    ocrPlugin as unknown as BuiltinPlugin,
    diffusionPlugin as unknown as BuiltinPlugin,
    vlaPlugin as unknown as BuiltinPlugin,
    classificationPlugin as unknown as BuiltinPlugin
  ]

  for (const plugin of builtins) {
    const expectedHandlers = truthTable[plugin.modelType]
    t.ok(expectedHandlers !== undefined, `${plugin.modelType} has a row in the brief truth table`)
    if (!expectedHandlers) continue
    for (const [handlerName, expected] of Object.entries(expectedHandlers)) {
      const handler = plugin.handlers[handlerName]
      t.ok(handler !== undefined, `${plugin.modelType}.${handlerName} is registered`)
      if (!handler) continue
      t.alike(
        handler.cancel,
        expected,
        `${plugin.modelType}.${handlerName} declares the expected cancel surface`
      )
      const result = pluginHandlerDefinitionRuntimeSchema.safeParse(handler)
      t.ok(
        result.success,
        `${plugin.modelType}.${handlerName} validates against the runtime schema`
      )
    }
  }
})
