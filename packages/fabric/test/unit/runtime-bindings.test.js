'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const {
  parseBindings,
  checkBindings,
  initializedBackend,
  workerResult
} = require('../regression/coexistence')

const policy = {
  qvacClients: ['/build/fabric.bare'],
  qvacProviders: ['/build/fabric.bare'],
  privateClients: ['/build/diffusion.bare'],
  gnuClients: ['/build/xdna.so']
}
const trace = [
  "123: binding file /build/fabric.bare [0] to /build/fabric.bare [0]: normal symbol `__cxa_throw' [QVAC_FABRIC_ABI_1]",
  "123: binding file /build/diffusion.bare [0] to /lib/libc.so.6 [0]: normal symbol `malloc' [GLIBC_2.2.5]",
  "123: binding file /build/xdna.so [0] to /lib/libstdc++.so.6 [0]: normal symbol `__cxa_throw' [CXXABI_1.3]"
].join('\n')

test('loader bindings preserve client, provider, symbol and version', () => {
  const bindings = parseBindings(trace)
  assert.equal(bindings.length, 3)
  assert.deepEqual(bindings[0], {
    client: '/build/fabric.bare',
    provider: '/build/fabric.bare',
    symbol: '__cxa_throw',
    version: 'QVAC_FABRIC_ABI_1'
  })
  assert.deepEqual(checkBindings(bindings, policy), [])
})

test('rejects host runtime answering a QVAC import', () => {
  const bindings = parseBindings(trace.replace('to /build/fabric.bare', 'to /lib/libstdc++.so.6'))
  assert.match(checkBindings(bindings, policy).join('\n'), /__cxa_throw bound to \/lib\/libstdc/)
})

test('rejects XDNA binding to exported libc++ despite successful loading', () => {
  const bindings = parseBindings(trace.replace('to /lib/libstdc++.so.6', 'to /build/fabric.bare'))
  assert.match(checkBindings(bindings, policy).join('\n'), /xdna.so: __cxa_throw/)
})

test('rejects diffusion importing core or runtime from fabric', () => {
  for (const symbol of ['ggml_backend_buffer_free', '_Znwm', '__cxa_throw']) {
    const bindings = parseBindings(
      trace +
        `\n123: binding file /build/diffusion.bare [0] to /build/fabric.bare [0]: normal symbol \`${symbol}'`
    )
    assert.match(
      checkBindings(bindings, policy).join('\n'),
      new RegExp('diffusion.bare: ' + symbol)
    )
  }
})

test('rejects missing traces or a backend that never loaded', () => {
  assert.ok(checkBindings([], policy).length >= 3)
  assert.match(
    checkBindings(parseBindings(trace.split('\n').slice(0, 2).join('\n')), policy).join('\n'),
    /gnu client was not observed/
  )
})

test('follows relocated runtime provider without exempting wrong bindings', () => {
  const bindings = parseBindings(
    trace.replace('to /build/fabric.bare', 'to /build/libggml-base.so')
  )
  assert.deepEqual(
    checkBindings(bindings, { ...policy, qvacProviders: ['/build/libggml-base.so'] }),
    []
  )
})

test('XDNA may import XRT class RTTI without treating it as a standard runtime symbol', () => {
  const bindings = parseBindings(
    trace +
      "\n123: binding file /build/xdna.so [0] to /build/libxrt_coreutil.so.2 [0]: normal symbol `_ZTIN3xrt6deviceE'"
  )
  assert.deepEqual(checkBindings(bindings, policy), [])
})

test('checks GNU abbreviated std names and libc++ ABI typeinfo', () => {
  for (const symbol of [
    '_ZNSaIcED1Ev',
    '_ZTINSt3__19exceptionE',
    '_ZTVN10__cxxabiv117__class_type_infoE',
    '_ZTTNSt3__113basic_ostreamIcNS_11char_traitsIcEEEE',
    '_ZTCNSt3__113basic_ostreamIcNS_11char_traitsIcEEEE0_NS_9basic_iosIcS2_EE'
  ]) {
    const bindings = parseBindings(
      trace +
        `\n123: binding file /build/xdna.so [0] to /build/fabric.bare [0]: normal symbol \`${symbol}'`
    )
    assert.match(checkBindings(bindings, policy).join('\n'), /xdna.so:/)
  }
})

test('checks standard library thunks while excluding XRT thunks', () => {
  for (const symbol of [
    '_ZThn8_NSt3__113basic_ostreamIcNS_11char_traitsIcEEED1Ev',
    '_ZTv0_n24_NSoD1Ev',
    '_ZTch0_v0_n24_NSt3__113basic_ostreamIcNS_11char_traitsIcEEED1Ev'
  ]) {
    const bindings = parseBindings(
      trace +
        `\n123: binding file /build/xdna.so [0] to /build/fabric.bare [0]: normal symbol \`${symbol}'`
    )
    assert.match(checkBindings(bindings, policy).join('\n'), /xdna.so:/)
  }
  const bindings = parseBindings(
    trace +
      "\n123: binding file /build/xdna.so [0] to /build/libxrt_coreutil.so.2 [0]: normal symbol `_ZThn8_N3xrt6deviceD1Ev'"
  )
  assert.deepEqual(checkBindings(bindings, policy), [])
})

test('records backend initialization paths rather than arbitrary loader messages', () => {
  for (const file of [
    '/build/libqvac-ggml-cpu-x64.so',
    '/build/libqvac-diffusion-ggml-vulkan.so',
    '/build/libqvac-speech-ggml-cuda.so',
    '/build/libggml-base.so.0'
  ]) {
    assert.equal(initializedBackend('123: calling init: ' + file), file)
  }
  assert.equal(initializedBackend('123: calling init: /lib/libstdc++.so.6'), null)
  assert.equal(initializedBackend('123: calling fini: /build/libqvac-ggml-cuda.so'), null)
})

test('worker completion identifies the actual native host despite mixed stdout', () => {
  const result = {
    kind: 'ggml-coexistence',
    order: 'fabric-first',
    hostExecutable: '/runtime/bin/bare'
  }
  assert.deepEqual(workerResult('native diagnostics\n' + JSON.stringify(result) + '\n'), result)
  assert.equal(workerResult('native diagnostics only'), null)
})
