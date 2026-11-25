'use strict'

const assert = require('node:assert/strict')
const { readFileSync } = require('node:fs')
const path = require('node:path')
const test = require('node:test')

const packageRoot = path.resolve(__dirname, '../..')
const fabricRoot = path.resolve(packageRoot, '../fabric')

function readJson(file) {
  return JSON.parse(readFileSync(file, 'utf8'))
}

function parseVersion(version) {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(version)
  assert.ok(match, `unsupported version: ${version}`)
  return match.slice(1).map(Number)
}

// The @qvac/fabric ranges this package uses: exact versions and carets.
function satisfies(version, range) {
  const caret = range.startsWith('^')
  const [major, minor, patch] = parseVersion(version)
  const [wantMajor, wantMinor, wantPatch] = parseVersion(caret ? range.slice(1) : range)
  if (!caret) return major === wantMajor && minor === wantMinor && patch === wantPatch
  if (major !== wantMajor) return false
  if (major === 0) return minor === wantMinor && patch >= wantPatch
  return minor > wantMinor || (minor === wantMinor && patch >= wantPatch)
}

function fabricSourceVersion() {
  const fabric = readJson(path.join(fabricRoot, 'vcpkg.json')).dependencies.find(
    (dependency) => dependency.name === 'qvac-fabric'
  )
  return fabric['version>='].replace(/#\d+$/, '')
}

test('caret ranges match the @qvac/fabric versions they allow', () => {
  assert.equal(satisfies('0.33.0', '^0.33.0'), true)
  assert.equal(satisfies('0.33.2', '^0.33.0'), true)
  assert.equal(satisfies('0.34.0', '^0.33.0'), false)
  assert.equal(satisfies('0.32.9', '^0.33.0'), false)
  assert.equal(satisfies('1.4.0', '^1.2.0'), true)
  assert.equal(satisfies('2.0.0', '^1.2.0'), false)
  assert.equal(satisfies('0.23.1', '0.23.1'), true)
  assert.equal(satisfies('0.23.2', '0.23.1'), false)
})

// Native builds use Fabric through @qvac/fabric; the browser build compiles
// Fabric from the source pinned in web/source-lock.json. Both must be the same
// Fabric release.
test('the browser build pins the Fabric release that @qvac/fabric is built from', (t) => {
  const range = readJson(path.join(packageRoot, 'package.json')).dependencies['@qvac/fabric']
  const workspaceVersion = readJson(path.join(fabricRoot, 'package.json')).version
  if (!satisfies(workspaceVersion, range)) {
    // The workspace @qvac/fabric is ahead of this package's range. The check
    // runs again when this package moves to the new @qvac/fabric.
    t.skip(`@qvac/fabric ${workspaceVersion} is outside ${range}`)
    return
  }
  const lock = readJson(path.join(packageRoot, 'web/source-lock.json'))
  assert.equal(
    lock.fabric.version,
    fabricSourceVersion(),
    `web/source-lock.json pins Fabric ${lock.fabric.version}, but @qvac/fabric ${workspaceVersion} is built from ${fabricSourceVersion()}. Update web/source-lock.json (version, commit, url, sha256).`
  )
})
