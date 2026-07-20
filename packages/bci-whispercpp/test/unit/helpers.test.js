'use strict'

const test = require('brittle')
const { computeWER } = require('../../lib/wer')
const { concatChunks } = require('../../bci')
const {
  UINT32_BYTES,
  FLOAT32_BYTES,
  TIMESTEPS_FIELD_OFFSET,
  CHANNELS_FIELD_OFFSET,
  STREAM_HEADER_BYTES,
  ADDON_EVENT
} = require('../../lib/constants')

test('[computeWER] identical strings score zero', (t) => {
  t.is(computeWER('the cat sat', 'the cat sat'), 0)
})

test('[computeWER] empty reference and hypothesis score zero', (t) => {
  t.is(computeWER('', ''), 0)
})

test('[computeWER] empty reference with words scores one', (t) => {
  t.is(computeWER('hello there', ''), 1)
})

test('[computeWER] single substitution is one error over reference length', (t) => {
  t.is(computeWER('the dog sat', 'the cat sat'), 1 / 3)
})

test('[computeWER] a missing word counts as one deletion', (t) => {
  t.is(computeWER('the cat', 'the cat sat'), 1 / 3)
})

test('[computeWER] an extra word counts as one insertion', (t) => {
  t.is(computeWER('the cat sat down', 'the cat sat'), 1 / 3)
})

test('[computeWER] casing and surrounding whitespace are normalised away', (t) => {
  t.is(computeWER('  The   CAT ', 'the cat'), 0)
})

test('[concatChunks] concatenates chunks in order', (t) => {
  const merged = concatChunks([new Uint8Array([1, 2]), new Uint8Array([3, 4, 5])])
  t.ok(merged instanceof Uint8Array)
  t.alike(Array.from(merged), [1, 2, 3, 4, 5])
})

test('[concatChunks] empty list yields an empty buffer', (t) => {
  const merged = concatChunks([])
  t.is(merged.byteLength, 0)
})

test('[concatChunks] single chunk is copied verbatim', (t) => {
  const merged = concatChunks([new Uint8Array([7, 8, 9])])
  t.alike(Array.from(merged), [7, 8, 9])
})

test('[constants] stream header layout matches the binary [T, C] format', (t) => {
  t.is(UINT32_BYTES, 4)
  t.is(FLOAT32_BYTES, 4)
  t.is(TIMESTEPS_FIELD_OFFSET, 0)
  t.is(CHANNELS_FIELD_OFFSET, 4)
  t.is(STREAM_HEADER_BYTES, 8)
})

test('[constants] addon event names are frozen and stable', (t) => {
  t.is(ADDON_EVENT.OUTPUT, 'Output')
  t.is(ADDON_EVENT.JOB_ENDED, 'JobEnded')
  t.is(ADDON_EVENT.ERROR, 'Error')
  t.ok(Object.isFrozen(ADDON_EVENT))
})
