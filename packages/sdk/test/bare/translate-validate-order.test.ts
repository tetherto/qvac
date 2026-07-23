import test from 'brittle'

// Bare-only: importing server/bare/ops/translate pulls native bare deps that
// bun unit tests cannot load. Schema coverage for missing `to` lives in
// test/unit/translation-schemas.test.ts; this file proves op ordering.

let idCounter = 0
function makeId(prefix: string): string {
  idCounter++
  return `${prefix}-${idCounter}-${Date.now()}`
}

test('translate: missing LLM `to` fails at schema parse before language detection', async (t) => {
  const [
    { registerModel, unregisterModel },
    { ModelType },
    { translate },
    { TranslationFailedError },
    { detectOne },
    { ZodError }
  ] = await Promise.all([
    import('@/server/bare/registry/model-registry'),
    import('@/schemas'),
    import('@/server/bare/ops/translate'),
    import('@/utils/errors-server'),
    import('@qvac/langdetect-text'),
    import('zod')
  ])

  // Undetermined text is the regression case: if detectOne runs before
  // translateServerParamsSchema.parse, the op throws TranslationFailedError
  // instead of the real missing-`to` schema error.
  const undeterminedText = '????'
  const detected = detectOne(undeterminedText)
  t.is(detected.code, 'und', 'fixture must stay undetermined for this assertion')
  t.is(detected.language, 'Undetermined')

  const modelId = makeId('llm-translate-missing-to')
  registerModel(modelId, {
    model: {} as never,
    path: '/tmp/llm.bin',
    config: {},
    modelType: ModelType.llamacppCompletion
  } as never)

  try {
    const gen = translate({
      modelId,
      text: undeterminedText,
      stream: false,
      modelType: ModelType.llamacppCompletion
    } as never)

    await gen.next()
    t.fail('expected translate to reject missing `to`')
  } catch (error) {
    t.ok(error instanceof ZodError, 'schema parse must win over language detection')
    t.ok(!(error instanceof TranslationFailedError), 'must not surface as TranslationFailedError')
    t.ok(
      (error as InstanceType<typeof ZodError>).issues.some((issue) => issue.path.includes('to')),
      'Zod issue path must point at `to`'
    )
  } finally {
    unregisterModel(modelId)
  }
})
