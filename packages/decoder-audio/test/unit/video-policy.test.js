'use strict'

const test = require('brittle')
const {
  resolveVideoOptions,
  samplingIntervalMs,
  keyframesSuitable,
  outputDimensions
} = require('../../video/config')
const { displayRotation, rotateRgb } = require('../../video/rotation')

test('video budgets reject invalid and oversized options', (t) => {
  for (const value of [0, -1, NaN, Infinity, 65, 1.5]) {
    t.exception(() => resolveVideoOptions({ maxFrames: value }))
  }
  t.exception(() => resolveVideoOptions({ maxDimension: 8192 }))
  t.exception(() => resolveVideoOptions({ mode: 'unknown' }))
  t.is(resolveVideoOptions({}).mode, 'auto')
  t.alike(outputDimensions(3840, 2160, 448), { width: 448, height: 252 })
  t.alike(outputDimensions(1280, 720, 448), { width: 448, height: 252 })
  t.alike(outputDimensions(64, 48, 448), { width: 64, height: 48 })
  t.exception(() => outputDimensions(65536, 65536, 448))
})

test('video sampling covers short and long clips within the same frame budget', (t) => {
  t.is(samplingIntervalMs(10000, 2, 64), 500)
  t.is(samplingIntervalMs(300000, 2, 64), 4687.5)
  t.is(samplingIntervalMs(10000, 2, 2), 5000)
})

test('auto key-frame selection requires 1-5 fps without sparse gaps or bursts', (t) => {
  t.ok(keyframesSuitable([0, 500, 1000, 1500], 2000))
  t.ok(keyframesSuitable([0, 1000], 2000))
  t.absent(keyframesSuitable([], 2000))
  t.absent(keyframesSuitable([0], 5000))
  t.absent(keyframesSuitable([0, 100, 200, 300, 400, 500], 1000))
  t.absent(keyframesSuitable([0, 100, 200, 300], 3000), 'mean rate alone cannot hide a long gap')
  t.absent(keyframesSuitable([0, NaN], 1000))
})

test('RGB rotation preserves pixels and validates the display matrix', (t) => {
  const pixels = Uint8Array.from([1, 0, 0, 2, 0, 0, 3, 0, 0, 4, 0, 0, 5, 0, 0, 6, 0, 0])
  const turned = rotateRgb(pixels, 3, 2, 90)
  t.is(turned.width, 2)
  t.is(turned.height, 3)
  t.alike(
    Array.from(turned.rgb).filter((_, i) => i % 3 === 0),
    [4, 1, 5, 2, 6, 3]
  )
  t.alike(rotateRgb(turned.rgb, 2, 3, 270).rgb, pixels)
  const matrix = Buffer.alloc(36)
  matrix.writeInt32LE(65536, 4)
  matrix.writeInt32LE(-65536, 12)
  matrix.writeInt32LE(1073741824, 32)
  t.is(displayRotation(matrix), 90)
  matrix.writeInt32LE(65536, 12)
  t.exception(() => displayRotation(matrix), 'mirroring is rejected')
})
