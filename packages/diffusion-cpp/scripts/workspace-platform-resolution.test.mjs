import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const root = new URL('../../../', import.meta.url)
const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
const desktopPackages = Object.keys(manifest.optionalDependencies)

// Read pnpm's generated block mappings without installing a YAML parser.
function entries(text, indent) {
  const result = new Map()
  let current
  for (const line of text.split('\n')) {
    if (!line.trim() || line.trimStart().startsWith('#')) continue
    const spaces = line.length - line.trimStart().length
    if (spaces === indent) {
      const match = line.trim().match(/^(?:'([^']+)'|"([^"]+)"|([^:]+)):\s*(.*)$/)
      assert.ok(match, `expected a lockfile mapping: ${line}`)
      current = { value: match[4].replace(/^['"]|['"]$/g, ''), block: '' }
      result.set(match[1] ?? match[2] ?? match[3], current)
    } else if (spaces > indent && current) {
      current.block += line + '\n'
    }
  }
  return result
}

const sections = entries(readFileSync(new URL('pnpm-lock.yaml', root), 'utf8'), 0)
const importers = entries(sections.get('importers').block, 2)
const snapshots = entries(sections.get('snapshots').block, 2)
const packages = entries(sections.get('packages').block, 2)

// A release train takes the packages outside it out of the workspace, and the
// lockfile then has no importer for them.
const workspace = readFileSync(new URL('pnpm-workspace.yaml', root), 'utf8')

for (const consumer of ['inference', 'sdk']) {
  const skip = workspace.includes(`"!packages/${consumer}"`) && 'left out of the workspace'
  const name = `${consumer}'s published diffusion fallback retains every desktop binary dependency`
  test(name, { skip }, () => {
    const importer = entries(importers.get(`packages/${consumer}`).block, 4)
    const dependencies = ['dependencies', 'devDependencies', 'optionalDependencies'].flatMap(
      (field) => [...entries(importer.get(field)?.block ?? '', 6)]
    )
    const dependency = new Map(dependencies).get(manifest.name)
    assert.ok(dependency, `${consumer} must resolve ${manifest.name}`)
    const version = entries(dependency.block, 8).get('version').value
    if (version.startsWith('link:')) {
      assert.equal(version, 'link:../diffusion-cpp')
      return
    }

    const snapshot = snapshots.get(`${manifest.name}@${version}`)
    assert.ok(snapshot, `missing published snapshot for ${manifest.name}@${version}`)
    const fields = entries(snapshot.block, 4)
    const optional = entries(fields.get('optionalDependencies')?.block ?? '', 6)
    const releaseVersion = version.split('(')[0]
    for (const name of desktopPackages) {
      assert.equal(optional.get(name)?.value, releaseVersion, `${name} must accompany the fallback`)
      assert.ok(packages.has(`${name}@${releaseVersion}`), `${name} must have a locked resolution`)
    }
  })
}

test('the workspace diffusion addon keeps its locally staged desktop binaries', () => {
  const importer = entries(importers.get('packages/diffusion-cpp').block, 4)
  const optional = entries(importer.get('optionalDependencies')?.block ?? '', 6)
  for (const name of desktopPackages) {
    assert.equal(optional.has(name), false, `${name} must be staged by link:platform locally`)
  }
})
