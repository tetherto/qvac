// qvac, duck and the kit are peers on one mesh, so they run the same Core and harness: the
// three manifests pin the same exact versions. The kit is not published: each product takes it
// from the workspace and bundles it into its archive, so what the kit imports comes from the
// product's own dependencies.
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { builtinModules } from 'node:module'
import { fileURLToPath } from 'node:url'

const repo = new URL('../../../', import.meta.url)
const manifests = Object.fromEntries(['packages/cli-kit', 'packages/cli', 'packages/duck'].map((dir) =>
  [dir, JSON.parse(readFileSync(new URL(`${dir}/package.json`, repo), 'utf8'))]))
const products = ['packages/cli', 'packages/duck']

test('the kit, qvac and duck pin the same @qvac/core and @qvac/harness, exactly', () => {
  for (const name of ['@qvac/core', '@qvac/harness']) {
    const pins = new Map(Object.entries(manifests).map(([dir, manifest]) => [dir, manifest.dependencies[name]]))
    const distinct = new Set(pins.values())
    assert.equal(distinct.size, 1, `${name}: ${[...pins].map(([dir, pin]) => `${dir} ${pin}`).join(', ')}`)
    assert.match([...distinct][0], /^\d/, `${name} is pinned to one exact version`)
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

test('qvac and duck declare every package the kit imports', () => {
  const imported = new Set()
  for (const file of sources(fileURLToPath(new URL('packages/cli-kit/src', repo)))) {
    for (const [, type, spec] of readFileSync(file, 'utf8').matchAll(/\b(?:import|export)(\s+type)?\b[^'";]*?\bfrom\s+'([^']+)'/g)) {
      if (type || /^[.#]/.test(spec) || spec.startsWith('node:') || builtinModules.includes(spec)) continue
      imported.add(spec.split('/').slice(0, spec.startsWith('@') ? 2 : 1).join('/'))
    }
  }
  assert.ok(imported.size > 0)
  for (const dir of products) {
    for (const name of imported) {
      assert.ok(manifests[dir].dependencies[name], `${dir} lacks ${name}`)
    }
  }
})

function sources (dir) {
  return readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.ts'))
    .map((entry) => `${entry.parentPath}/${entry.name}`)
}
