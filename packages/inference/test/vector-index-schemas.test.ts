import test from 'brittle'
import {
  createVectorIndexParamsSchema,
  findVectorRowLengthMismatch,
  toWireVectorIds,
  VECTOR_ID_RESERVED,
  VectorIndexStorage,
  vectorIdWireSchema,
  vectorIndexRequestSchema,
  vectorIndexResponseSchema
} from '@/schemas/vector-index'
import { requestSchema, responseSchema } from '@/schemas/common'

test('vectorIdWireSchema: accepts decimal strings up to 2^64 - 2 and safe integers', (t) => {
  t.ok(vectorIdWireSchema.safeParse('0').success)
  t.ok(vectorIdWireSchema.safeParse('18446744073709551614').success)
  t.ok(vectorIdWireSchema.safeParse(0).success)
  t.ok(vectorIdWireSchema.safeParse(Number.MAX_SAFE_INTEGER).success)
})

test('vectorIdWireSchema: rejects the reserved padding id and malformed ids', (t) => {
  t.absent(vectorIdWireSchema.safeParse(VECTOR_ID_RESERVED).success, 'UINT64_MAX is reserved')
  t.absent(vectorIdWireSchema.safeParse('18446744073709551616').success, 'above 64 bits')
  t.absent(vectorIdWireSchema.safeParse('-1').success, 'negative string')
  t.absent(vectorIdWireSchema.safeParse('007').success, 'leading zeros')
  t.absent(vectorIdWireSchema.safeParse('12a').success, 'non-numeric')
  t.absent(vectorIdWireSchema.safeParse('').success, 'empty')
  t.absent(vectorIdWireSchema.safeParse(-1).success, 'negative number')
  t.absent(vectorIdWireSchema.safeParse(1.5).success, 'fractional number')
  t.absent(vectorIdWireSchema.safeParse(Number.MAX_SAFE_INTEGER + 2).success, 'unsafe integer')
})

test('createVectorIndexParamsSchema: defaults storage to turbovec-q4', (t) => {
  const parsed = createVectorIndexParamsSchema.parse({ dim: 16 })
  t.is(parsed.storage, 'turbovec-q4')
  t.absent(createVectorIndexParamsSchema.safeParse({ dim: 0 }).success)
  t.absent(createVectorIndexParamsSchema.safeParse({ dim: 16, storage: 'q16' }).success)
})

test('vectorIndexRequestSchema: every operation is a member of the global request union', (t) => {
  const requests = [
    { type: 'vectorIndex', operation: 'create', dim: 8 },
    { type: 'vectorIndex', operation: 'load', path: 'index.qvi' },
    { type: 'vectorIndex', operation: 'add', indexId: 'i', ids: ['1', 2], vectors: [[1], [2]] },
    { type: 'vectorIndex', operation: 'search', indexId: 'i', queries: [[1]], k: 1 },
    { type: 'vectorIndex', operation: 'remove', indexId: 'i', ids: ['1'] },
    { type: 'vectorIndex', operation: 'contains', indexId: 'i', ids: ['1'] },
    { type: 'vectorIndex', operation: 'write', indexId: 'i', path: 'index.qvi' },
    { type: 'vectorIndex', operation: 'dispose', indexId: 'i' }
  ]
  for (const request of requests) {
    t.ok(vectorIndexRequestSchema.safeParse(request).success, `${request.operation} parses`)
    t.ok(requestSchema.safeParse(request).success, `${request.operation} is in the request union`)
  }
})

test('vectorIndexRequestSchema: rejects empty batches and non-positive k', (t) => {
  t.absent(
    vectorIndexRequestSchema.safeParse({
      type: 'vectorIndex',
      operation: 'add',
      indexId: 'i',
      ids: [],
      vectors: []
    }).success
  )
  t.absent(
    vectorIndexRequestSchema.safeParse({
      type: 'vectorIndex',
      operation: 'search',
      indexId: 'i',
      queries: [[1]],
      k: 0
    }).success
  )
  t.absent(
    vectorIndexRequestSchema.safeParse({
      type: 'vectorIndex',
      operation: 'write',
      indexId: 'i',
      path: ''
    }).success
  )
})

test('vectorIndexResponseSchema: responses are members of the global response union', (t) => {
  const responses = [
    { type: 'vectorIndex', operation: 'create', indexId: 'i', dim: 8, storage: 'q8', length: 0 },
    { type: 'vectorIndex', operation: 'load', indexId: 'i', dim: 8, length: 3 },
    { type: 'vectorIndex', operation: 'add', length: 2 },
    { type: 'vectorIndex', operation: 'search', results: [[{ id: '1', score: 0.5 }], []] },
    { type: 'vectorIndex', operation: 'remove', removed: [true, false], length: 1 },
    { type: 'vectorIndex', operation: 'contains', present: [true] },
    { type: 'vectorIndex', operation: 'write', path: '/tmp/index.qvi' },
    { type: 'vectorIndex', operation: 'dispose', disposed: true }
  ]
  for (const response of responses) {
    t.ok(vectorIndexResponseSchema.safeParse(response).success, `${response.operation} parses`)
    t.ok(
      responseSchema.safeParse(response).success,
      `${response.operation} is in the response union`
    )
  }
})

test('helpers: ids, row lengths, and storage parsing', (t) => {
  t.alike(toWireVectorIds([1n, '2', 3]), ['1', '2', 3])
  t.is(
    findVectorRowLengthMismatch(
      [
        [1, 2],
        [3, 4]
      ],
      2
    ),
    -1
  )
  t.is(findVectorRowLengthMismatch([[1, 2], [3]], 2), 1)
  t.alike(Object.values(VectorIndexStorage), ['f32', 'q8', 'q4', 'turbovec-q4', 'turbovec-q2'])
  t.is(VectorIndexStorage.TURBOVEC_Q4, 'turbovec-q4')
})
