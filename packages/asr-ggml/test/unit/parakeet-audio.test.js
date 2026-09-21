'use strict'

const test = require('brittle')
const {
  PCM_S16_SCALE,
  pcmS16ToFloat32,
  toFloat32Chunk,
  mergeFloat32Chunks,
  normalizeChunkToFloat32
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

// ─── normalizeChunkToFloat32 — the unified audio boundary ────────────────────

test('normalizeChunkToFloat32 passes Float32Array through as-is', (t) => {
  const chunk = new Float32Array([0.25, -0.5])
  t.is(normalizeChunkToFloat32(chunk, 's16le'), chunk, 'same reference is returned')
})

test('normalizeChunkToFloat32 scales Int16Array samples', (t) => {
  const out = normalizeChunkToFloat32(new Int16Array([16384, -32768]), 's16le')
  t.ok(out instanceof Float32Array)
  t.is(out[0], 0.5)
  t.is(out[1], -1)
})

test('normalizeChunkToFloat32 decodes Uint8Array bytes per the byte format', (t) => {
  // s16le: 16384 -> 0x4000 little-endian.
  const s16 = normalizeChunkToFloat32(new Uint8Array([0x00, 0x40]), 's16le')
  t.is(s16.length, 1)
  t.is(s16[0], 0.5)

  // f32le: 1.0f little-endian is 00 00 80 3f.
  const f32 = normalizeChunkToFloat32(new Uint8Array([0x00, 0x00, 0x80, 0x3f]), 'f32le')
  t.is(f32.length, 1)
  t.is(f32[0], 1)
})

test('normalizeChunkToFloat32 handles unaligned f32 byte views', (t) => {
  // A view whose byteOffset is not a multiple of 4 must be copied, not
  // reinterpreted in place.
  const backing = new Uint8Array(9)
  backing.set([0x00, 0x00, 0x80, 0x3f], 1) // 1.0f at offset 1
  backing.set([0x00, 0x00, 0x00, 0x40], 5) // 2.0f at offset 5
  const view = new Uint8Array(backing.buffer, 1, 8)

  const out = normalizeChunkToFloat32(view, 'f32le')
  t.is(out.length, 2)
  t.is(out[0], 1)
  t.is(out[1], 2)
})

test('normalizeChunkToFloat32 rejects byte counts that do not divide evenly', (t) => {
  t.exception(
    () => normalizeChunkToFloat32(new Uint8Array([1]), 's16le'),
    'odd byte count cannot be s16le samples'
  )
  t.exception(
    () => normalizeChunkToFloat32(new Uint8Array([1, 2, 3]), 'f32le'),
    'byte count not divisible by 4 cannot be f32le samples'
  )
})
