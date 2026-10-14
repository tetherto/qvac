import test from 'brittle'
import { assertModelSrcMatchesModelType } from '@/utils/load-model-validation'
import { ModelSrcTypeMismatchError } from '@/errors'
import { ModelType, ERROR_CODES } from '@/schemas'
import { inferModelTypeFromModelSrc } from '@/schemas/model-src-utils'
import { LAYA_MULTILINGUAL_322M_Q8_0 } from '@/models/registry/models'

test('embedding descriptors accept an explicit decision type without changing inference', (t) => {
  t.execution(() =>
    assertModelSrcMatchesModelType(LAYA_MULTILINGUAL_322M_Q8_0, ModelType.llamacppDecision)
  )
  t.is(inferModelTypeFromModelSrc(LAYA_MULTILINGUAL_322M_Q8_0), ModelType.llamacppEmbedding)
})

test('legacy embedding engines and addon-only descriptors accept an explicit decision type', (t) => {
  for (const descriptor of [
    { src: 'registry://example/laya.gguf', engine: 'embeddings' },
    { src: 'registry://example/laya.gguf', engine: '@qvac/embed-llamacpp' },
    { src: 'registry://example/laya.gguf', addon: 'embeddings' }
  ]) {
    t.execution(() => assertModelSrcMatchesModelType(descriptor, ModelType.llamacppDecision))
  }
})

test('the embedding-to-decision override rejects the reverse and unrelated engine mismatches', (t) => {
  for (const [inferred, explicit] of [
    [ModelType.llamacppDecision, ModelType.llamacppEmbedding],
    [ModelType.llamacppDecision, 'embeddings'],
    [ModelType.llamacppEmbedding, ModelType.llamacppCompletion],
    [ModelType.llamacppCompletion, ModelType.llamacppDecision]
  ] as const) {
    try {
      assertModelSrcMatchesModelType(
        { src: 'registry://example/model.gguf', engine: inferred },
        explicit
      )
      t.fail('Expected ModelSrcTypeMismatchError')
    } catch (error) {
      t.ok(error instanceof ModelSrcTypeMismatchError)
    }
  }
})

test('assertModelSrcMatchesModelType: descriptor engine vs incompatible canonical modelType throws', (t) => {
  const llamaDescriptor = {
    src: 'registry://example/llama.gguf',
    engine: ModelType.llamacppCompletion
  }

  try {
    assertModelSrcMatchesModelType(llamaDescriptor, ModelType.whispercppTranscription)
    t.fail('Expected ModelSrcTypeMismatchError to be thrown')
  } catch (error) {
    t.ok(error instanceof ModelSrcTypeMismatchError)
    t.is((error as ModelSrcTypeMismatchError).code, ERROR_CODES.MODEL_SRC_TYPE_MISMATCH)
    t.ok(
      (error as Error).message.includes(ModelType.llamacppCompletion),
      'message should mention the inferred (modelSrc) type'
    )
    t.ok(
      (error as Error).message.includes(ModelType.whispercppTranscription),
      'message should mention the resolved (explicit) type'
    )
  }
})

test('assertModelSrcMatchesModelType: alias on the explicit side still throws when engine differs', (t) => {
  const llamaDescriptor = {
    src: 'registry://example/llama.gguf',
    engine: ModelType.llamacppCompletion
  }

  try {
    // "whisper" is an alias for ModelType.whispercppTranscription — must be
    // normalized before comparison so the mismatch is still detected.
    assertModelSrcMatchesModelType(llamaDescriptor, 'whisper')
    t.fail('Expected ModelSrcTypeMismatchError to be thrown')
  } catch (error) {
    t.ok(error instanceof ModelSrcTypeMismatchError)
    t.ok(
      (error as Error).message.includes(ModelType.whispercppTranscription),
      "alias 'whisper' should be normalized to canonical in the message"
    )
  }
})

test('assertModelSrcMatchesModelType: alias matching its canonical does NOT throw', (t) => {
  const llamaDescriptor = {
    src: 'registry://example/llama.gguf',
    engine: ModelType.llamacppCompletion
  }

  // "llm" is an alias for ModelType.llamacppCompletion — should match.
  t.execution(() => assertModelSrcMatchesModelType(llamaDescriptor, 'llm'))
})

test('assertModelSrcMatchesModelType: matching canonical on both sides does NOT throw', (t) => {
  const llamaDescriptor = {
    src: 'registry://example/llama.gguf',
    engine: ModelType.llamacppCompletion
  }

  t.execution(() => assertModelSrcMatchesModelType(llamaDescriptor, ModelType.llamacppCompletion))
})

test('assertModelSrcMatchesModelType: plain string modelSrc skips preflight', (t) => {
  // Cannot infer engine from a bare URL — validator must be a no-op even when
  // the explicit modelType could be wrong. The runtime layer remains the
  // backstop for unmounted/incompatible models.
  t.execution(() =>
    assertModelSrcMatchesModelType(
      'https://example.com/whatever.gguf',
      ModelType.whispercppTranscription
    )
  )
})

test('assertModelSrcMatchesModelType: descriptor without engine/addon skips preflight', (t) => {
  const opaqueDescriptor = { src: 'registry://example/something.bin' }

  t.execution(() =>
    assertModelSrcMatchesModelType(opaqueDescriptor, ModelType.whispercppTranscription)
  )
})

test('assertModelSrcMatchesModelType: descriptor addon-only path normalizes through aliases', (t) => {
  // No engine field — falls back to addon. addon "llm" is an alias and must
  // be normalized to "llamacpp-completion" before comparison.
  const addonOnlyDescriptor = {
    src: 'registry://example/llama.gguf',
    addon: 'llm'
  }

  try {
    assertModelSrcMatchesModelType(addonOnlyDescriptor, ModelType.whispercppTranscription)
    t.fail('Expected ModelSrcTypeMismatchError')
  } catch (error) {
    t.ok(error instanceof ModelSrcTypeMismatchError)
    t.ok(
      (error as Error).message.includes(ModelType.llamacppCompletion),
      "addon 'llm' should normalize to its canonical engine in the message"
    )
  }
})

test('assertModelSrcMatchesModelType: legacy package-name engine matches canonical', (t) => {
  const legacyDescriptor = {
    src: 'registry://example/llama.gguf',
    engine: '@qvac/llm-llamacpp'
  }

  t.execution(() => assertModelSrcMatchesModelType(legacyDescriptor, ModelType.llamacppCompletion))
})

test('assertModelSrcMatchesModelType: tag-style legacy engine resolves and detects mismatch', (t) => {
  const tagStyleDescriptor = {
    src: 'registry://example/llama.gguf',
    engine: 'generation'
  }

  try {
    assertModelSrcMatchesModelType(tagStyleDescriptor, ModelType.whispercppTranscription)
    t.fail('Expected ModelSrcTypeMismatchError')
  } catch (error) {
    t.ok(error instanceof ModelSrcTypeMismatchError)
    t.ok(
      (error as Error).message.includes(ModelType.llamacppCompletion),
      "tag-style 'generation' should resolve to canonical in the message"
    )
  }
})

test("assertModelSrcMatchesModelType: addon 'vad' resolves to onnx-vad canonical engine", (t) => {
  const vadAddonDescriptor = {
    src: 'registry://example/silero-vad.onnx',
    addon: 'vad' as const
  }

  try {
    assertModelSrcMatchesModelType(vadAddonDescriptor, ModelType.whispercppTranscription)
    t.fail('Expected ModelSrcTypeMismatchError')
  } catch (error) {
    t.ok(error instanceof ModelSrcTypeMismatchError)
    t.ok(
      (error as Error).message.includes('onnx-vad'),
      "addon 'vad' should resolve to canonical 'onnx-vad' in the message"
    )
  }
})
