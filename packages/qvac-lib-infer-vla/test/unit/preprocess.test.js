'use strict'

const test = require('brittle')
const { preprocessImage, padState } = require('../../addon.js')

test('preprocessImage: output length is 3 * size * size', (t) => {
  const src = new Uint8Array(4 * 4 * 3)
  const out = preprocessImage(src, 4, 4, { size: 8 })
  t.is(out.length, 3 * 8 * 8)
  t.ok(out instanceof Float32Array)
})

test('preprocessImage: normalizes uint8 pixels into [-1, 1]', (t) => {
  // 2×4 source letterboxed into 4×4 — padLeft=2 so out[0] falls in the pad.
  const src = new Uint8Array(2 * 4 * 3).fill(255)
  const out = preprocessImage(src, 2, 4, { size: 4 })
  let max = -Infinity
  for (const v of out) if (v > max) max = v
  t.ok(max > 0.99, 'max should be near +1')
  // Padded region must be -1 (0 normalised * 2 - 1).
  t.is(out[0], -1)
})

test('preprocessImage: aspect-ratio letterbox leaves padded region', (t) => {
  // 8×4 source -> target 8. Ratio = 1, new_w = 8, new_h = 4 -> pad_top = 4.
  const src = new Uint8Array(8 * 4 * 3).fill(128)
  const out = preprocessImage(src, 8, 4, { size: 8 })
  // Top-left should be padded (-1), bottom-half should have content.
  t.is(out[0], -1)
  const bottomRowIdx = (8 - 1) * 8 // plane 0, last row start
  t.ok(out[bottomRowIdx] > -1, 'bottom rows should contain resized pixels')
})

test('preprocessImage: rejects mismatched length', (t) => {
  t.exception(() => preprocessImage(new Uint8Array(10), 4, 4), /expected 48/)
})

test('padState: zero-pads to target dim', (t) => {
  const out = padState([0.5, -0.25, 1.0], 8)
  t.ok(out instanceof Float32Array)
  t.is(out.length, 8)
  t.alike(Array.from(out.subarray(0, 3)), [0.5, -0.25, 1.0])
  for (let i = 3; i < 8; i++) t.is(out[i], 0)
})

test('padState: rejects longer-than-target input', (t) => {
  t.exception(() => padState([1, 2, 3, 4, 5], 4), /exceeds targetDim/)
})
