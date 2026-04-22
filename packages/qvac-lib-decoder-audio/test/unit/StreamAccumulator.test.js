'use strict'

const test = require('brittle')
const createStreamAccumulator = require('../../utils/createStreamAccumulator.js')
const { QvacErrorDecoderAudio, ERR_CODES } = require('../../utils/error.js')

const TARGET_BUFFER_SIZE = 64000

function createTestAccumulator (onChunk, onFinish) {
  return createStreamAccumulator({
    onChunk: onChunk || (() => {}),
    onFinish: onFinish || (() => {})
  })
}

test('processData accumulates and emits chunks at target size', async (t) => {
  const chunks = []
  const accumulator = createTestAccumulator(
    chunk => chunks.push(new Uint8Array(chunk))
  )

  await accumulator.processData(Buffer.alloc(1000, 0x42))
  t.is(chunks.length, 0)

  await accumulator.processData(Buffer.alloc(TARGET_BUFFER_SIZE + 500, 0x43))
  t.is(chunks.length, 1)
  t.is(chunks[0].length, TARGET_BUFFER_SIZE)
  t.is(chunks[0][0], 0x42)
  t.is(chunks[0][TARGET_BUFFER_SIZE - 1], 0x43)

  await accumulator.finish()
  t.is(chunks.length, 2)
  t.is(chunks[1].length, 1500)
  t.is(chunks[1][0], 0x43)
})

test('processData handles multiple small chunks correctly', async (t) => {
  const chunkSizes = []
  const accumulator = createTestAccumulator(
    chunk => chunkSizes.push(chunk.length)
  )

  const smallChunkSize = Math.floor(TARGET_BUFFER_SIZE / 3) + 1
  await accumulator.processData(Buffer.alloc(smallChunkSize))
  await accumulator.processData(Buffer.alloc(smallChunkSize))
  t.is(chunkSizes.length, 0)

  await accumulator.processData(Buffer.alloc(smallChunkSize))
  t.is(chunkSizes.length, 1)
  t.is(chunkSizes[0], TARGET_BUFFER_SIZE)
})

test('finish emits remaining data and calls onFinish', async (t) => {
  const chunks = []
  let finishCalled = false
  const accumulator = createTestAccumulator(
    chunk => chunks.push(chunk.length),
    () => { finishCalled = true }
  )

  await accumulator.processData(Buffer.alloc(100))
  await accumulator.finish()

  t.is(chunks.length, 1)
  t.is(chunks[0], 100)
  t.ok(finishCalled)
})

test('finish handles empty buffer correctly', async (t) => {
  const chunks = []
  let finishCalled = false
  const accumulator = createTestAccumulator(
    chunk => chunks.push(chunk.length),
    () => { finishCalled = true }
  )

  await accumulator.finish()
  t.is(chunks.length, 0)
  t.ok(finishCalled)
})

test('validates buffer size configuration', (t) => {
  t.exception(() => {
    createStreamAccumulator({
      onChunk: () => {},
      onFinish: () => {},
      targetBufferSize: 1000
    })
  }, QvacErrorDecoderAudio)

  let captured
  try {
    createStreamAccumulator({
      onChunk: () => {},
      onFinish: () => {},
      targetBufferSize: 1000
    })
  } catch (err) {
    captured = err
  }
  t.ok(captured instanceof QvacErrorDecoderAudio)
  t.is(captured.code, ERR_CODES.BUFFER_SIZE_TOO_SMALL)
  t.is(captured.name, 'BUFFER_SIZE_TOO_SMALL')
  t.is(captured.message, 'Target buffer size is too small')

  const accumulator = createStreamAccumulator({
    onChunk: () => {},
    onFinish: () => {},
    targetBufferSize: TARGET_BUFFER_SIZE + 1000
  })
  t.ok(accumulator)
  t.end()
})

test('propagates callback errors', async (t) => {
  const chunkErrorAccumulator = createTestAccumulator(() => {
    throw new Error('Chunk error')
  })

  await t.exception(async () => {
    await chunkErrorAccumulator.processData(Buffer.alloc(TARGET_BUFFER_SIZE))
  }, /Chunk error/)

  const finishErrorAccumulator = createTestAccumulator(
    () => {},
    () => { throw new Error('Finish error') }
  )

  await t.exception(async () => {
    await finishErrorAccumulator.finish()
  }, /Finish error/)
})

test('handles concurrent processData calls', async (t) => {
  const chunks = []
  const accumulator = createTestAccumulator(
    chunk => chunks.push(chunk.length)
  )

  await Promise.all([
    accumulator.processData(Buffer.alloc(30000)),
    accumulator.processData(Buffer.alloc(30000)),
    accumulator.processData(Buffer.alloc(30000))
  ])

  t.is(chunks.length, 1)
  t.is(chunks[0], TARGET_BUFFER_SIZE)
})

test('preserves data integrity across chunks', async (t) => {
  const receivedData = []
  const accumulator = createTestAccumulator(
    chunk => receivedData.push(...chunk)
  )

  const pattern1 = Buffer.alloc(32000, 0xAA)
  const pattern2 = Buffer.alloc(32000, 0xBB)
  const pattern3 = Buffer.alloc(16000, 0xCC)

  await accumulator.processData(pattern1)
  await accumulator.processData(pattern2)
  await accumulator.processData(pattern3)
  await accumulator.finish()

  t.is(receivedData.filter(b => b === 0xAA).length, 32000)
  t.is(receivedData.filter(b => b === 0xBB).length, 32000)
  t.is(receivedData.filter(b => b === 0xCC).length, 16000)
})

test('handles large data with multiple while loop iterations', async (t) => {
  const chunks = []
  const accumulator = createTestAccumulator(
    chunk => chunks.push(chunk.length)
  )

  await accumulator.processData(Buffer.alloc(TARGET_BUFFER_SIZE * 2.5))
  t.is(chunks.length, 2)
  t.is(chunks[0], TARGET_BUFFER_SIZE)
  t.is(chunks[1], TARGET_BUFFER_SIZE)

  await accumulator.finish()
  t.is(chunks.length, 3)
  t.is(chunks[2], TARGET_BUFFER_SIZE * 0.5)
})
