'use strict'

const test = require('brittle')
const { addModelRequestSchema, baseModelFields } = require('../../lib/model-schema')

const VALID_PAYLOAD = {
  source: 'https://huggingface.co/org/repo/resolve/abc123/model.gguf',
  engine: '@qvac/llm-llamacpp',
  licenseId: 'Apache-2.0'
}

test('addModelRequestSchema accepts minimal valid payload', async t => {
  const result = addModelRequestSchema.safeParse(VALID_PAYLOAD)
  t.ok(result.success)
})

test('addModelRequestSchema accepts full valid payload', async t => {
  const result = addModelRequestSchema.safeParse({
    ...VALID_PAYLOAD,
    description: 'test model',
    quantization: 'q4_0',
    params: '1B',
    notes: 'some notes',
    tags: ['generation', 'instruct'],
    deprecated: false,
    deprecatedAt: '',
    replacedBy: '',
    deprecationReason: '',
    skipExisting: true
  })
  t.ok(result.success)
})

test('addModelRequestSchema rejects unknown fields (.strict)', async t => {
  const result = addModelRequestSchema.safeParse({
    ...VALID_PAYLOAD,
    extraField: 'should fail'
  })
  t.absent(result.success)
  t.ok(result.error.issues.some(i => i.message.includes('extraField') || i.code === 'unrecognized_keys'))
})

test('addModelRequestSchema rejects missing required fields', async t => {
  for (const field of ['source', 'engine', 'licenseId']) {
    const payload = { ...VALID_PAYLOAD }
    delete payload[field]
    const result = addModelRequestSchema.safeParse(payload)
    t.absent(result.success, `should reject when ${field} is missing`)
  }
})

test('addModelRequestSchema rejects empty required fields', async t => {
  for (const field of ['source', 'engine', 'licenseId']) {
    const result = addModelRequestSchema.safeParse({ ...VALID_PAYLOAD, [field]: '' })
    t.absent(result.success, `should reject empty ${field}`)
  }
})

test('addModelRequestSchema enforces max length on description', async t => {
  const result = addModelRequestSchema.safeParse({
    ...VALID_PAYLOAD,
    description: 'x'.repeat(513)
  })
  t.absent(result.success)
  t.ok(result.error.issues.some(i => i.path.includes('description')), 'error references description field')
})

test('addModelRequestSchema enforces max length on deprecationReason', async t => {
  const result = addModelRequestSchema.safeParse({
    ...VALID_PAYLOAD,
    deprecationReason: 'x'.repeat(513)
  })
  t.absent(result.success)
  t.ok(result.error.issues.some(i => i.path.includes('deprecationReason')), 'error references deprecationReason field')
})

test('addModelRequestSchema enforces tag limits', async t => {
  const tooManyTags = addModelRequestSchema.safeParse({
    ...VALID_PAYLOAD,
    tags: Array.from({ length: 51 }, (_, i) => `tag-${i}`)
  })
  t.absent(tooManyTags.success, 'rejects > 50 tags')
  t.ok(tooManyTags.error.issues.some(i => i.path.includes('tags')), 'error references tags field')

  const tagTooLong = addModelRequestSchema.safeParse({
    ...VALID_PAYLOAD,
    tags: ['x'.repeat(129)]
  })
  t.absent(tagTooLong.success, 'rejects tag > 128 chars')
  t.ok(tagTooLong.error.issues.length > 0, 'error has issues')
})

test('addModelRequestSchema rejects non-boolean skipExisting', async t => {
  const result = addModelRequestSchema.safeParse({
    ...VALID_PAYLOAD,
    skipExisting: 'yes'
  })
  t.absent(result.success)
  t.ok(result.error.issues.some(i => i.path.includes('skipExisting')), 'error references skipExisting field')
})

test('addModelRequestSchema rejects non-object input', async t => {
  t.absent(addModelRequestSchema.safeParse(null).success)
  t.absent(addModelRequestSchema.safeParse('string').success)
  t.absent(addModelRequestSchema.safeParse(42).success)
})

test('baseModelFields is exported for CI schema reuse', async t => {
  t.ok(baseModelFields)
  t.ok(baseModelFields.source)
  t.ok(baseModelFields.engine)
  t.ok(baseModelFields.licenseId)
})
