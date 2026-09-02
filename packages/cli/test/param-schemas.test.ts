import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  configSchemaForAddon,
  configParamModel,
  paramFields,
  coerceParam,
  validateParam
} from '@/configure/param-schemas'
import { TTS_ENGINES, buildEntry } from '@/configure/presets'

describe('configure: param-schemas', () => {
  it('resolves a config schema for every built-in addon', () => {
    // Addon strings are model-type aliases; the SDK resolves each to its schema,
    // so a new addon is documented without wiring anything here.
    for (const addon of [
      'llm',
      'embeddings',
      'whisper',
      'bci',
      'parakeet',
      'nmt',
      'tts',
      'ocr',
      'diffusion',
      'audiogen',
      'vla',
      'classification'
    ]) {
      assert.ok(configSchemaForAddon(addon), `expected a schema for ${addon}`)
    }
    assert.equal(configSchemaForAddon('not-a-real-addon'), undefined)
    assert.equal(configSchemaForAddon(null), undefined)
    assert.equal(configSchemaForAddon(undefined), undefined)
  })

  it('models a plain-object addon as editable fields', () => {
    const schema = configSchemaForAddon('llm')
    assert.ok(schema)
    const model = configParamModel(schema)
    assert.ok(model)
    assert.equal(model.kind, 'object')
    if (model.kind === 'object') assert.ok(model.fields.length > 10)
  })

  it('models a discriminated-union addon as variants with described fields', () => {
    const schema = configSchemaForAddon('tts')
    assert.ok(schema)
    const model = configParamModel(schema)
    assert.ok(model)
    assert.equal(model.kind, 'variants')
    if (model.kind !== 'variants') return

    assert.equal(model.discriminator, 'ttsEngine')
    const values = model.variants.map((v) => v.value)
    assert.ok(values.includes('cosyvoice3'), `expected cosyvoice3 in ${values.join(', ')}`)

    for (const variant of model.variants) {
      // the discriminator is chosen up front, not edited as a field
      assert.ok(!variant.fields.some((f) => f.name === model.discriminator))
      for (const f of variant.fields) assert.ok(f.schema)
    }
  })

  it('ships a valid starter for every TTS engine', () => {
    const schema = configSchemaForAddon('tts')
    assert.ok(schema)
    for (const engine of TTS_ENGINES) {
      const built = buildEntry('speech', engine)
      assert.equal(built.entry.config?.['ttsEngine'], engine)
      assert.ok(built.entry.src, `${engine} starter has a model`)
      const res = schema.safeParse(built.entry.config)
      assert.ok(
        res.success,
        `${engine} starter config invalid: ${res.success ? '' : JSON.stringify(res.error.issues)}`
      )
    }
  })

  it('shows an object field shape and enforces it on input', () => {
    const ttsSchema = configSchemaForAddon('tts')
    assert.ok(ttsSchema)
    const model = configParamModel(ttsSchema)
    assert.ok(model?.kind === 'variants')
    const audio8 = model.variants.find((v) => v.value === 'audio8')
    const ref = audio8?.fields.find((f) => f.name === 'referenceAudioSrc')
    assert.ok(ref)

    // hint names the required key rather than a bare "object" or a truncated dump
    assert.match(ref.type, /\{ src: string/)
    // the guided Text/Object flow: accepts a string, and drills into the object's
    // own fields (each with its description), not a raw JSON blob
    assert.equal(ref.acceptsString, true)
    assert.ok(ref.objectFields, 'referenceAudioSrc exposes object fields')
    assert.ok(ref.objectFields.length > 5, 'object exposes all its fields, not just src')
    const src = ref.objectFields.find((f) => f.name === 'src')
    assert.ok(src)
    assert.equal(src.required, true)
    assert.match(src.description, /model file/i)
    // an optional field the old "+N optional" hint hid is now discoverable
    assert.ok(ref.objectFields.some((f) => f.name === 'registryPath'))

    // a plain path string and a valid descriptor pass
    assert.equal(validateParam(ref, '/foo.wav'), true)
    assert.equal(validateParam(ref, '{"src":"/foo.wav"}'), true)
    // JS-style object (single quotes) is not valid JSON — must not slip through as a string
    assert.notEqual(validateParam(ref, "{ foo: 'bar' }"), true)
    // valid JSON but missing the required src
    assert.notEqual(validateParam(ref, '{"foo":"bar"}'), true)
    // and the mistake isn't silently stored as a string
    assert.equal(coerceParam("{ foo: 'bar' }"), undefined)
  })

  it('detects the nmt discriminator (engine) and its variants', () => {
    const schema = configSchemaForAddon('nmt')
    assert.ok(schema)
    const model = configParamModel(schema)
    assert.ok(model)
    assert.equal(model.kind, 'variants')
    if (model.kind === 'variants') assert.equal(model.discriminator, 'engine')
  })

  it('enumerates llamacpp fields with type hints and descriptions', () => {
    const schema = configSchemaForAddon('llm')
    assert.ok(schema)
    const fields = paramFields(schema)
    assert.ok(fields.length > 10)

    const ctx = fields.find((f) => f.name === 'ctx_size')
    assert.ok(ctx)
    assert.equal(ctx.type, 'number')
    assert.match(ctx.description, /context window/i)

    const temp = fields.find((f) => f.name === 'temp')
    assert.ok(temp)
    assert.match(temp.type, /<= 2/)

    // every field carries a schema for validation
    for (const f of fields) assert.ok(f.schema)
  })

  it('coerces raw input to the right JSON type, blank clears', () => {
    assert.equal(coerceParam('1024'), 1024)
    assert.equal(coerceParam('true'), true)
    assert.equal(coerceParam(''), undefined)
    assert.equal(coerceParam('   '), undefined)
    assert.equal(coerceParam('gpu'), 'gpu')
    assert.deepEqual(coerceParam('["stop"]'), ['stop'])
  })

  it('renders enum values bare and accepts bare/single/double-quoted input', () => {
    const schema = configSchemaForAddon('embeddings')
    assert.ok(schema)
    const attention = paramFields(schema).find((f) => f.name === 'attention')
    assert.ok(attention)
    // hint shows bare values, matching how they're typed (no surrounding quotes)
    assert.equal(attention.type, 'causal | non-causal')
    // all three forms the user might type (incl. the single-quoted form the
    // description renders) coerce and validate the same
    assert.equal(coerceParam("'causal'"), 'causal')
    assert.equal(validateParam(attention, 'causal'), true)
    assert.equal(validateParam(attention, "'causal'"), true)
    assert.equal(validateParam(attention, '"causal"'), true)
    assert.equal(validateParam(attention, "'non-causal'"), true)
  })

  it('validates input against the real field schema', () => {
    const schema = configSchemaForAddon('llm')
    assert.ok(schema)
    const fields = paramFields(schema)
    const temp = fields.find((f) => f.name === 'temp')
    const ctx = fields.find((f) => f.name === 'ctx_size')
    assert.ok(temp && ctx)

    assert.equal(validateParam(temp, '0.8'), true)
    assert.equal(validateParam(temp, ''), true) // blank = clear
    assert.notEqual(validateParam(temp, '3'), true) // above max 2
    assert.equal(validateParam(ctx, '2048'), true)
    assert.notEqual(validateParam(ctx, 'abc'), true)
  })
})
