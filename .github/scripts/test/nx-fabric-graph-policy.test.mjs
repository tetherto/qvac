// Guards on-pr-nx's affected selection against a fabric <-> consumer cycle.
//
// nx attributes every import under packages/fabric to @qvac/fabric, test
// harnesses included. packages/fabric/test/integration requires llm-llamacpp
// and embed-llamacpp on purpose, which gave nx the edges fabric -> llm and
// fabric -> embed. Every native addon depends on fabric, so a change to either
// consumer marked fabric affected and, through it, every other consumer:
// classification, translation, ggml-rpc-server, turbovec, model-fit, ocr, vla.
// The llm-llamacpp 0.61.2 / embed-llamacpp 0.48.2 release PR (#5185) built and
// tested all of them.
//
// The edges only exist while pnpm links the consumer from the workspace. When
// another package's range stops matching the workspace version, pnpm installs
// the consumer from the registry and nx resolves the import to that npm node
// instead, so the fan-out can vanish and reappear with unrelated version bumps.
// That is why this is asserted from source rather than from nx's output.
//
// packages/fabric/project.json negates each such edge with an
// `!@qvac/<consumer>` implicitDependencies entry. This test fails if fabric
// imports a consumer whose edge is not negated, so adding a consumer to the
// harness, or removing an entry that looks unexplained in JSON, cannot quietly
// bring the fan-out back.
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync, existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')
const PACKAGE_DIR = join(root, 'packages')
const FABRIC_DIR = join(PACKAGE_DIR, 'fabric')
const FABRIC = '@qvac/fabric'

const SKIP_DIRS = new Set(['node_modules', 'prebuilds', 'build', 'vcpkg_installed', 'model', '.git'])
const SOURCE_EXT = /\.(?:c|m)?[jt]s$/
const IMPORT = /(?:require\(\s*|import\(\s*|from\s+)['"](@qvac\/[^'"/]+)/g

const DEP_FIELDS = ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies']

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'))
}

function fabricConsumers() {
  const consumers = new Set()
  for (const dir of readdirSync(PACKAGE_DIR)) {
    const manifest = join(PACKAGE_DIR, dir, 'package.json')
    if (!existsSync(manifest)) continue
    const pkg = readJson(manifest)
    if (pkg.name === FABRIC) continue
    if (DEP_FIELDS.some((field) => pkg[field] && FABRIC in pkg[field])) consumers.add(pkg.name)
  }
  return consumers
}

function sourceFiles(dir) {
  const files = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) files.push(...sourceFiles(join(dir, entry.name)))
    } else if (SOURCE_EXT.test(entry.name)) {
      files.push(join(dir, entry.name))
    }
  }
  return files
}

function importedConsumers(consumers) {
  const found = new Map()
  for (const file of sourceFiles(FABRIC_DIR)) {
    for (const [, name] of readFileSync(file, 'utf8').matchAll(IMPORT)) {
      if (consumers.has(name) && !found.has(name)) found.set(name, file.slice(root.length + 1))
    }
  }
  return found
}

test('fabric negates the nx edge to every consumer it imports', () => {
  const consumers = fabricConsumers()
  const imported = importedConsumers(consumers)
  const { implicitDependencies = [] } = readJson(join(FABRIC_DIR, 'project.json'))

  // The scan must still see the harness this test was written for; an empty
  // result would otherwise pass vacuously.
  assert.ok(imported.has('@qvac/llm-llamacpp'), 'expected fabric to import @qvac/llm-llamacpp')
  assert.ok(imported.has('@qvac/embed-llamacpp'), 'expected fabric to import @qvac/embed-llamacpp')

  for (const [name, file] of imported) {
    assert.ok(
      implicitDependencies.includes(`!${name}`),
      `${file} imports ${name}, a @qvac/fabric consumer; add "!${name}" to ` +
        'implicitDependencies in packages/fabric/project.json or every change to it ' +
        'selects all fabric consumers in on-pr-nx'
    )
  }
})
