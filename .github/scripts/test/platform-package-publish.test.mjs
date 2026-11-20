import test from 'node:test'
import assert from 'node:assert/strict'
import {
  checkPackageSizes,
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
