'use strict'

const test = require('brittle')
const {
  PCM_S16_SCALE,
  pcmS16ToFloat32,
  toFloat32Chunk,
  mergeFloat32Chunks
} = require('../../lib/audio')

test('PCM_S16_SCALE is 2^15', (t) => {
  t.is(PCM_S16_SCALE, 32768)
})

test('pcmS16ToFloat32 scales int16 samples into [-1, 1]', (t) => {
  const input = new Int16Array([0, 16384, -16384, -32768])
  const out = pcmS16ToFloat32(input)

  t.ok(out instanceof Float32Array, 'returns a Float32Array')
  t.is(out.length, input.length, 'length is preserved')
  t.is(out[0], 0)
  t.is(out[1], 0.5)
  t.is(out[2], -0.5)
  t.is(out[3], -1)
})

test('toFloat32Chunk returns Float32Array input unchanged', (t) => {
  const chunk = new Float32Array([0.1, -0.2, 0.3])
  t.is(toFloat32Chunk(chunk), chunk, 'same reference is returned')
})

test('toFloat32Chunk converts s16le byte chunks to float32', (t) => {
  // 16384 -> 0x4000, -16384 -> 0xC000 (little-endian bytes).
  const bytes = new Uint8Array([0x00, 0x40, 0x00, 0xc0])
  const out = toFloat32Chunk(bytes)

  t.ok(out instanceof Float32Array, 'returns a Float32Array')
  t.is(out.length, 2, 'two int16 samples decoded from four bytes')
  t.is(out[0], 0.5)
  t.is(out[1], -0.5)
})

test('mergeFloat32Chunks concatenates chunks in order', (t) => {
  const merged = mergeFloat32Chunks([
    new Float32Array([1, 2]),
    new Float32Array([]),
    new Float32Array([3, 4, 5])
  ])

  t.ok(merged instanceof Float32Array)
  t.alike(Array.from(merged), [1, 2, 3, 4, 5])
})

test('mergeFloat32Chunks returns an empty array for empty input', (t) => {
  t.is(mergeFloat32Chunks([]).length, 0)
})
