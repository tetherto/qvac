// The kit is not published: each product takes it from the workspace and bundles it into its
// archive, so what the kit imports comes from the product's own dependencies. Each product hosts
// Core and the harness itself, at the versions its own manifest pins.
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const repo = new URL('../../../', import.meta.url)
const manifests = Object.fromEntries(['packages/cli-kit', 'packages/cli', 'packages/duck'].map((dir) =>
  [dir, JSON.parse(readFileSync(new URL(`${dir}/package.json`, repo), 'utf8'))]))
const products = ['packages/cli', 'packages/duck']

test('qvac and duck pin @qvac/core and @qvac/harness exactly', () => {
  for (const dir of products) {
    for (const name of ['@qvac/core', '@qvac/harness']) {
      assert.match(manifests[dir].dependencies[name], /^\d/, `${dir} ${name}`)
    }
  }
})

test('the kit is private; qvac and duck bundle it from the workspace', () => {
  assert.equal(manifests['packages/cli-kit'].private, true)
  for (const dir of products) {
    assert.equal(manifests[dir].dependencies['@qvac/cli-kit'], 'workspace:*', dir)
    assert.deepEqual(manifests[dir].bundleDependencies, ['@qvac/cli-kit'], dir)
  }
})

test('qvac and duck declare every dependency of the kit, at its range', () => {
  for (const dir of products) {
    for (const [name, range] of Object.entries(manifests['packages/cli-kit'].dependencies)) {
      assert.equal(manifests[dir].dependencies[name], range, `${dir} ${name}`)
    }
  }
})
