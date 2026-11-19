'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const { parseBindings, checkBindings } = require('../regression/coexistence')

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
    '_ZTVN10__cxxabiv117__class_type_infoE'
  ]) {
    const bindings = parseBindings(
      trace +
        `\n123: binding file /build/xdna.so [0] to /build/fabric.bare [0]: normal symbol \`${symbol}'`
    )
    assert.match(checkBindings(bindings, policy).join('\n'), /xdna.so:/)
  }
})
