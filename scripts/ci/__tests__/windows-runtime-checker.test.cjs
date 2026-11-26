const assert = require('node:assert/strict')
const test = require('node:test')

const checker =
  import('../../../.github/actions/prebuilds-check-windows-runtime/prebuilds-check-windows-runtime.mjs')

test('packaged VC14 Release runtimes are accepted, including suffixed DLLs', async () => {
  const { violations } = await checker
  const names = [
    'msvcp140.dll',
    'msvcp140_1.dll',
    'msvcp140_2.dll',
    'msvcp140_atomic_wait.dll',
    'msvcp140_codecvt_ids.dll',
    'vcruntime140.dll',
    'vcruntime140_1.dll',
    'concrt140.dll'
  ]
  const packaged = new Set(names)
  assert.deepEqual(
    violations('addon.bare', names.map((name) => name.toUpperCase()).join('\r\n'), packaged),
    []
  )
})

test('packaging cannot make Debug or legacy runtimes acceptable', async () => {
  const { violations } = await checker
  for (const name of [
    'msvcp140d.dll',
    'msvcp140d_atomic_wait.dll',
    'msvcp140d_codecvt_ids.dll',
    'vcruntime140d.dll',
    'vcruntime140_1d.dll',
    'concrt140d.dll',
    'ucrtbased.dll',
    'msvcr120.dll',
    'msvcp120.dll',
    'concrt120.dll'
  ]) {
    for (const packaged of [new Set(), new Set([name])]) {
      assert.deepEqual(violations('addon.bare', name, packaged), [
        `addon.bare -> unsupported Debug/legacy runtime ${name}`
      ])
    }
  }
})

test('Release runtime imports require a packaged DLL', async () => {
  const { violations } = await checker
  assert.deepEqual(violations('addon.bare', 'msvcp140_atomic_wait.dll'), [
    'addon.bare -> missing packaged runtime msvcp140_atomic_wait.dll'
  ])
})

test('Windows system runtimes and dumpbin banners are not redistributable imports', async () => {
  const { violations } = await checker
  assert.deepEqual(
    violations(
      'addon.bare',
      [
        'Dump of file C:\\package\\msvcp140d.dll',
        'ucrtbase.dll',
        'msvcrt.dll',
        'api-ms-win-crt-runtime-l1-1-0.dll',
        'kernel32.dll'
      ].join('\r\n')
    ),
    []
  )
})
