'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const { assertMossBackend } = require('../../test/utils/mossBackend')

const assertions = { is: assert.equal, ok: assert.ok, fail: assert.fail }
const gpu = (backendId) => ({ backendDevice: 1, backendId, gpuUnsupported: 0 })
const cpu = { backendDevice: 0, backendId: 0, gpuUnsupported: 0 }

for (const [backend, id] of [
  ['metal', 1],
  ['cuda', 2],
  ['CUDA', 2],
  ['CuDa', 2],
  ['vulkan', 3],
  ['VULKAN', 3],
  ['VuLkAn', 3],
  ['opencl', 4]
]) {
  test(`MOSS backend gate accepts ${backend} only when that backend ran`, () => {
    assertMossBackend(assertions, 'MOSS', gpu(id), true, backend)
    for (const other of [1, 2, 3, 4].filter((candidate) => candidate !== id)) {
      assert.throws(() => assertMossBackend(assertions, 'MOSS', gpu(other), true, backend))
    }
    assert.throws(() => assertMossBackend(assertions, 'MOSS', cpu, true, backend))
  })
}

test('MOSS backend gate rejects absent, unknown and fallback GPU telemetry', () => {
  for (const stats of [
    undefined,
    {},
    gpu(undefined),
    gpu(0),
    gpu(99),
    { ...gpu(2), gpuUnsupported: 1 }
  ]) {
    assert.throws(() => assertMossBackend(assertions, 'MOSS', stats, true))
  }
  assert.throws(() => assertMossBackend(assertions, 'MOSS', gpu(2), true, 'typo'))
  assert.throws(() => assertMossBackend(assertions, 'MOSS', gpu(undefined), true, 'toString'))
})

test('MOSS backend gate preserves the unpinned cascade and explicit CPU control', () => {
  for (const id of [1, 2, 3, 4]) assertMossBackend(assertions, 'MOSS', gpu(id), true)
  for (const pin of ['', 'cuda', 'vulkan']) {
    assertMossBackend(assertions, 'MOSS', cpu, false, pin)
    assert.throws(() => assertMossBackend(assertions, 'MOSS', gpu(2), false, pin))
  }
})
