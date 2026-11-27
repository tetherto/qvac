import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, writeFileSync, rmSync, mkdirSync, renameSync, copyFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  cxxRuntimeViolations,
  fabricRuntimeViolations,
  parseVersionedSymbols,
  xdnaRuntimeViolations,
  formatViolations,
  isForbiddenSymbol,
  parseNeeded,
  parseUndefined
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
    ''
  ].join('\n')
  assert.deepEqual(parseUndefined(nm), [
    '_ZSt15__once_callable',
    '__cxa_atexit',
    'cudaMalloc',
    '_Unwind_Resume'
  ])
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
    '__dynamic_cast'
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
    '_ZTI9my_struct'
  ]) {
    assert.equal(isForbiddenSymbol(symbol), false, symbol)
  }
})

test('a module passes only without a C++ runtime in NEEDED or undefined', () => {
  assert.deepEqual(
    cxxRuntimeViolations({
      needed: ['libm.so.6', 'libgcc_s.so.1', 'libc.so.6'],
      undefinedSymbols: ['__cxa_atexit', '_Unwind_Resume', 'cudaMalloc']
    }),
    { needed: [], symbols: [] }
  )
  assert.deepEqual(
    cxxRuntimeViolations({
      needed: ['libstdc++.so.6', 'libc++abi.so.1', 'libc.so.6'],
      undefinedSymbols: ['_ZSt15__once_callable', '__cxa_atexit']
    }),
    { needed: ['libstdc++.so.6', 'libc++abi.so.1'], symbols: ['_ZSt15__once_callable'] }
  )
})

test('the report names the file, the NEEDED entries and the first symbols', () => {
  const report = formatViolations(
    'prebuilds/linux-x64/libqvac-ggml-cuda.so',
    { needed: ['libstdc++.so.6'], symbols: ['_ZSt9terminatev', '_Znwm', '_ZdlPv'] },
    2
  )
  assert.equal(
    report,
    [
      'prebuilds/linux-x64/libqvac-ggml-cuda.so',
      '  NEEDED: libstdc++.so.6',
      '  3 undefined C++ runtime symbols, first:',
      '    _ZSt9terminatev',
      '    _Znwm'
    ].join('\n')
  )
})

test('XDNA requires the XRT system ABI, which remains forbidden for other modules', () => {
  const module = {
    needed: ['libstdc++.so.6', 'libxrt_coreutil.so.2', 'libc.so.6'],
    undefinedSymbols: ['_ZSt9terminatev', '_Znwm', '__cxa_throw']
  }
  assert.deepEqual(xdnaRuntimeViolations(module), { needed: [], symbols: [] })
  assert.deepEqual(cxxRuntimeViolations(module).needed, ['libstdc++.so.6'])
})

test('XDNA rejects a missing system ABI and leaked ggml or libc++ references', () => {
  assert.deepEqual(
    xdnaRuntimeViolations({
      needed: ['libc++.so.1', 'libc++abi.so.1'],
      undefinedSymbols: [
        'ggml_backend_init',
        'gguf_init_empty',
        '_ZNSt3__16chrono12steady_clock3nowEv'
      ]
    }),
    {
      needed: [
        'missing libstdc++.so.6',
        'missing libxrt_coreutil.so.2',
        'libc++.so.1',
        'libc++abi.so.1'
      ],
      symbols: ['ggml_backend_init', 'gguf_init_empty', '_ZNSt3__16chrono12steady_clock3nowEv']
    }
  )
})

test('the CLI permits only the explicitly requested XDNA module to use the XRT ABI', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'qvac-xdna-runtime-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const readelf = join(root, 'readelf')
  const nm = join(root, 'nm')
  const cli = fileURLToPath(new URL('../check-linux-module-cxx-runtime.mjs', import.meta.url))
  const run = (...args) =>
    spawnSync(process.execPath, [cli, root, ...args], {
      encoding: 'utf8',
      env: { ...process.env, NM: nm, READELF: readelf }
    })
  // Only the simulated XDNA and CUDA modules use the system runtime.
  for (const tool of [readelf, nm]) {
    const source =
      tool === readelf
        ? `#!/usr/bin/env node
const file = process.argv.at(-1).split('/').at(-1)
if (/xdna|cuda/.test(file)) { console.log('(NEEDED) Shared library: [libstdc++.so.6]'); console.log('(NEEDED) Shared library: [libxrt_coreutil.so.2]') }
`
        : `#!/usr/bin/env node
if (/xdna|cuda/.test(process.argv.at(-1).split('/').at(-1))) console.log('_ZSt9terminatev U')
`
    writeFileSync(tool, source, { mode: 0o755 })
  }
  writeFileSync(join(root, 'libqvac-ggml-cpu.so'), '')
  assert.equal(run('--xdna').status, 1, 'XDNA must actually be present')
  writeFileSync(join(root, 'libqvac-ggml-xdna.so'), '')
  assert.equal(run().status, 1, 'XDNA requires explicit opt-in')
  const valid = run('--xdna')
  assert.equal(valid.status, 0, valid.stdout + valid.stderr)
  writeFileSync(join(root, 'libqvac-ggml-cuda.so'), '')
  const invalid = run('--xdna')
  assert.equal(invalid.status, 1, 'CUDA must retain its static-runtime check')
  assert.match(invalid.stdout, /libqvac-ggml-cuda\.so/)
})

const SHARED_RUNTIME = {
  needed: ['libqvac-ggml-base-1.so', 'libc.so.6'],
  undefinedSymbols: [
    '__cxa_throw@QVAC_GGML_BASE_ABI_1',
    '_Znwm@QVAC_GGML_BASE_ABI_1',
    '__cxa_atexit@GLIBC_2.2.5'
  ],
  definedSymbols: ['bare_register'],
  fabric: {
    soname: 'libqvac-ggml-base-1.so',
    symbols: ['__cxa_throw@@QVAC_GGML_BASE_ABI_1', '_Znwm@@QVAC_GGML_BASE_ABI_1']
  }
}

test('shared Fabric validation accepts only versioned imports exported by the required provider', () => {
  assert.deepEqual(fabricRuntimeViolations(SHARED_RUNTIME), { needed: [], symbols: [] })
  for (const symbol of ['_Znwm', '_Znwm@OTHER', '_ZdlPv@QVAC_GGML_BASE_ABI_1']) {
    assert.deepEqual(
      fabricRuntimeViolations({ ...SHARED_RUNTIME, undefinedSymbols: [symbol] }).symbols,
      [symbol]
    )
  }
})

test('shared Fabric validation rejects missing providers, private runtimes and empty imports', () => {
  assert.ok(
    fabricRuntimeViolations({ ...SHARED_RUNTIME, needed: ['libstdc++.so.6'] }).needed.length
  )
  assert.ok(
    fabricRuntimeViolations({ ...SHARED_RUNTIME, fabric: { ...SHARED_RUNTIME.fabric, soname: '' } })
      .needed.length
  )
  assert.ok(
    fabricRuntimeViolations({ ...SHARED_RUNTIME, definedSymbols: ['__cxa_throw'] }).symbols.length
  )
  assert.ok(fabricRuntimeViolations({ ...SHARED_RUNTIME, undefinedSymbols: [] }).symbols.length)
  assert.ok(
    fabricRuntimeViolations({
      ...SHARED_RUNTIME,
      fabric: { ...SHARED_RUNTIME.fabric, symbols: ['__cxa_throw'] }
    }).symbols.length
  )
})

test('versioned symbols retain import and export versions', () => {
  assert.deepEqual(
    parseVersionedSymbols(
      '__cxa_throw@@QVAC_GGML_BASE_ABI_1 T 123 10\n_Znwm@QVAC_GGML_BASE_ABI_1 U\n'
    ),
    ['__cxa_throw@@QVAC_GGML_BASE_ABI_1', '_Znwm@QVAC_GGML_BASE_ABI_1']
  )
})

test('CLI verifies a real versioned shared core and rejects an unresolved runtime import', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'fabric-runtime-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const compile = (args) => {
    const result = spawnSync('cc', args, { cwd: dir, encoding: 'utf8' })
    assert.equal(result.status, 0, result.stderr)
  }
  writeFileSync(join(dir, 'provider.c'), 'void __cxa_throw(void) {}')
  writeFileSync(
    join(dir, 'provider.map'),
    'QVAC_GGML_BASE_ABI_1 { global: __cxa_throw; local: *; };'
  )
  compile([
    '-shared',
    '-nostdlib',
    '-fPIC',
    'provider.c',
    '-Wl,-soname,libqvac-ggml-base-1.so',
    '-Wl,--version-script=provider.map',
    '-o',
    'libqvac-ggml-base-1.so'
  ])
  writeFileSync(
    join(dir, 'addon.c'),
    'extern void __cxa_throw(void); void addon(void) { __cxa_throw(); }'
  )
  compile([
    '-shared',
    '-nostdlib',
    '-fPIC',
    'addon.c',
    '-L.',
    '-l:libqvac-ggml-base-1.so',
    '-o',
    'addon.bare'
  ])
  const checker = fileURLToPath(new URL('../check-linux-module-cxx-runtime.mjs', import.meta.url))
  const check = () =>
    spawnSync(
      process.execPath,
      [checker, '--fabric', join(dir, 'libqvac-ggml-base-1.so'), join(dir, 'consumer')],
      { encoding: 'utf8' }
    )
  mkdirSync(join(dir, 'consumer'))
  renameSync(join(dir, 'addon.bare'), join(dir, 'consumer', 'addon.bare'))
  let result = check()
  assert.equal(result.status, 0, result.stdout + result.stderr)
  const meta = join(dir, 'node_modules/@qvac/fabric')
  const platform = join(dir, 'node_modules/@qvac/fabric-linux-x64')
  mkdirSync(meta, { recursive: true })
  mkdirSync(join(platform, 'prebuilds/linux-x64/qvac__fabric-linux-x64'), { recursive: true })
  const manifest = JSON.stringify({ exports: { './package': './package.json' } })
  writeFileSync(join(meta, 'package.json'), manifest)
  writeFileSync(join(platform, 'package.json'), manifest)
  copyFileSync(
    join(dir, 'libqvac-ggml-base-1.so'),
    join(platform, 'prebuilds/linux-x64/qvac__fabric-linux-x64/libqvac-ggml-base-1.so')
  )
  const installed = spawnSync(
    process.execPath,
    [checker, '--fabric-host', 'linux-x64', 'consumer'],
    {
      cwd: dir,
      encoding: 'utf8'
    }
  )
  assert.equal(installed.status, 0, installed.stdout + installed.stderr)
  compile(['-shared', '-nostdlib', '-fPIC', 'addon.c', '-o', 'consumer/addon.bare'])
  result = check()
  assert.equal(result.status, 1, result.stdout + result.stderr)
  assert.match(result.stdout, /missing ggml-base DT_NEEDED/)
})
