import test from 'node:test'
import assert from 'node:assert/strict'
import {
  checkPackageSizes,
  backendsFirst,
  bySize,
  plan
} from '../../actions/npm-publish-platform-packages/npm-publish-platform-packages.mjs'

const meta = { name: '@qvac/fabric', version: '1.0.0' }
const slices = ['linux-x64-cuda', 'linux-x64'].map((host) => ({
  name: '@qvac/fabric-' + host,
  version: meta.version
}))

test('packed-size preflight checks every backend and base package', () => {
  const checked = []
  checkPackageSizes(slices, (slice) => {
    checked.push(slice.name)
    return { size: 134_000_000 }
  })
  assert.deepEqual(
    checked,
    slices.map((slice) => slice.name)
  )
  assert.throws(
    () => checkPackageSizes(slices, () => ({ size: 191_000_000 })),
    /packed size.*exceeds/
  )
  assert.throws(() => checkPackageSizes(slices, () => ({})), /exceeds/)
})

test('a retry publishes only missing packages after validating existing backend contents', () => {
  const publish = plan({
    meta,
    slices,
    view: (args) =>
      args[1].includes('cuda')
        ? { status: 0, stdout: '1.0.0', stderr: '' }
        : { status: 1, stdout: '', stderr: 'E404' },
    integrity: { published: () => 'same', staged: () => 'same' }
  })
  assert.deepEqual(publish, slices.slice(1))
})

test('a backend from another build prevents a partial release from continuing', () => {
  assert.throws(
    () =>
      plan({
        meta,
        slices,
        view: (args) =>
          args[1].includes('cuda')
            ? { status: 0, stdout: '1.0.0', stderr: '' }
            : { status: 1, stdout: '', stderr: 'E404' },
        integrity: { published: () => 'other', staged: () => 'same' }
      }),
    /different build/
  )
})

test('CUDA publishes before the base even when directory order and size order put base first', async (t) => {
  const fs = await import('node:fs')
  const os = await import('node:os')
  const path = await import('node:path')
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'publish-order-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  for (const suffix of ['linux-x64', 'linux-x64-cuda']) {
    const dir = path.join(root, 'qvac-fabric-' + suffix)
    fs.mkdirSync(dir)
    fs.writeFileSync(
      path.join(dir, 'package.json'),
      JSON.stringify({ name: '@qvac/fabric-' + suffix, version: '1.0.0' })
    )
  }
  const actual = fs
    .readdirSync(root)
    .sort()
    .map((dir) => JSON.parse(fs.readFileSync(path.join(root, dir, 'package.json'))))
  assert.equal(actual[0].name, '@qvac/fabric-linux-x64')
  const sized = bySize(actual, () => 100_000_000, 200_417_383).order
  const ordered = backendsFirst(sized, {
    optionalDependencies: { '@qvac/fabric-linux-x64': '1.0.0' }
  })
  assert.deepEqual(
    ordered.map((slice) => slice.name),
    ['@qvac/fabric-linux-x64-cuda', '@qvac/fabric-linux-x64']
  )
  assert.deepEqual(
    backendsFirst(ordered.slice(1), {
      optionalDependencies: { '@qvac/fabric-linux-x64': '1.0.0' }
    }),
    ordered.slice(1)
  )
})
