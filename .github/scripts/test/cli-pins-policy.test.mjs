// qvac, duck and the kit are peers on one mesh, so they run the same Core and harness: the
// three manifests pin the same exact versions, and both products take the kit from the workspace.
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const manifests = Object.fromEntries(['packages/cli-kit', 'packages/cli', 'packages/duck'].map((dir) =>
  [dir, JSON.parse(readFileSync(new URL(`../../../${dir}/package.json`, import.meta.url), 'utf8'))]))

test('the kit, qvac and duck pin the same @qvac/core and @qvac/harness, exactly', () => {
  for (const name of ['@qvac/core', '@qvac/harness']) {
    const pins = new Map(Object.entries(manifests).map(([dir, manifest]) => [dir, manifest.dependencies[name]]))
    const distinct = new Set(pins.values())
    assert.equal(distinct.size, 1, `${name}: ${[...pins].map(([dir, pin]) => `${dir} ${pin}`).join(', ')}`)
    assert.match([...distinct][0], /^\d/, `${name} is pinned to one exact version`)
  }
})

test('qvac and duck build on the workspace kit', () => {
  for (const dir of ['packages/cli', 'packages/duck']) {
    assert.equal(manifests[dir].dependencies['@qvac/cli-kit'], 'workspace:*', dir)
  }
})
