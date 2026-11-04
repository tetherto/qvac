import test from 'node:test'
import assert from 'node:assert/strict'

import {
  cxxRuntimeViolations,
  formatViolations,
  isForbiddenSymbol,
  parseNeeded,
  parseUndefined,
} from '../lib/linux-module-cxx-runtime.mjs'

const GNU_READELF = `
Dynamic section at offset 0x1a2b3c contains 30 entries:
  Tag        Type                         Name/Value
 0x0000000000000001 (NEEDED)             Shared library: [libcudart.so.13]
 0x0000000000000001 (NEEDED)             Shared library: [libstdc++.so.6]
 0x0000000000000001 (NEEDED)             Shared library: [libgcc_s.so.1]
 0x000000000000000e (SONAME)             Library soname: [libqvac-ggml-cuda.so]
`

const LLVM_READELF = `
Dynamic section at offset 0x4f8 contains 3 entries:
  Tag                Type     Name/Value
  0x0000000000000001 (NEEDED) Shared library: [libc++.so.1]
  0x0000000000000001 (NEEDED) Shared library: [libc.so.6]
  0x0000000000000000 (NULL)   0x0
`

test('NEEDED entries parse from GNU and LLVM readelf', () => {
  assert.deepEqual(parseNeeded(GNU_READELF), ['libcudart.so.13', 'libstdc++.so.6', 'libgcc_s.so.1'])
  assert.deepEqual(parseNeeded(LLVM_READELF), ['libc++.so.1', 'libc.so.6'])
})

test('undefined symbols lose their version suffix', () => {
  const nm = [
    '_ZSt15__once_callable@GLIBCXX_3.4.11 U',
    '__cxa_atexit@GLIBC_2.2.5 U ',
    'cudaMalloc U',
    '_Unwind_Resume@@GCC_3.0 U',
    '',
  ].join('\n')
  assert.deepEqual(parseUndefined(nm), ['_ZSt15__once_callable', '__cxa_atexit', 'cudaMalloc', '_Unwind_Resume'])
})

test('libstdc++ and libc++ symbols are forbidden', () => {
  for (const symbol of [
    '_ZSt15__once_callable',
    '_ZNSt18condition_variable10notify_allEv',
    '_ZNKSt7__cxx1112basic_stringIcSt11char_traitsIcESaIcEE4sizeEv',
    '_ZNSt3__16chrono12steady_clock3nowEv',
    '_ZNKSt3__112basic_stringIcNS_11char_traitsIcEENS_9allocatorIcEEE4findEcm',
    '_ZNSaIcEC1Ev',
    '_ZNSs4_Rep20_S_empty_rep_storageE',
    '_ZTISt9exception',
    '_ZTVN10__cxxabiv117__class_type_infoE',
    '_Znwm',
    '_ZdlPvm',
    '_ZdaPv',
    '__cxa_guard_acquire',
    '__cxa_throw',
    '__gxx_personality_v0',
    '__dynamic_cast',
  ]) {
    assert.equal(isForbiddenSymbol(symbol), true, symbol)
  }
})

test('glibc, libgcc_s and non-std symbols are allowed', () => {
  for (const symbol of [
    '__cxa_atexit',
    '__cxa_finalize',
    '__cxa_thread_atexit_impl',
    '_Unwind_Resume',
    '_Unwind_RaiseException',
    'cudaMalloc',
    'ggml_backend_dev_get',
    'pthread_once',
    '_ZN4ggml6detail3fooEv',
    '_ZTI9my_struct',
  ]) {
    assert.equal(isForbiddenSymbol(symbol), false, symbol)
  }
})

test('a module passes only without a C++ runtime in NEEDED or undefined', () => {
  assert.deepEqual(
    cxxRuntimeViolations({
      needed: ['libm.so.6', 'libgcc_s.so.1', 'libc.so.6'],
      undefinedSymbols: ['__cxa_atexit', '_Unwind_Resume', 'cudaMalloc'],
    }),
    { needed: [], symbols: [] },
  )
  assert.deepEqual(
    cxxRuntimeViolations({
      needed: ['libstdc++.so.6', 'libc++abi.so.1', 'libc.so.6'],
      undefinedSymbols: ['_ZSt15__once_callable', '__cxa_atexit'],
    }),
    { needed: ['libstdc++.so.6', 'libc++abi.so.1'], symbols: ['_ZSt15__once_callable'] },
  )
})

test('the report names the file, the NEEDED entries and the first symbols', () => {
  const report = formatViolations(
    'prebuilds/linux-x64/libqvac-ggml-cuda.so',
    { needed: ['libstdc++.so.6'], symbols: ['_ZSt9terminatev', '_Znwm', '_ZdlPv'] },
    2,
  )
  assert.equal(
    report,
    [
      'prebuilds/linux-x64/libqvac-ggml-cuda.so',
      '  NEEDED: libstdc++.so.6',
      '  3 undefined C++ runtime symbols, first:',
      '    _ZSt9terminatev',
      '    _Znwm',
    ].join('\n'),
  )
})
