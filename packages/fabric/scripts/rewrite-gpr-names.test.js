'use strict'

const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { expectedImports, expectedOptionalDependencies } = require('./platform-slices')
const { rewriteMetaGprNames } = require('./rewrite-gpr-names')

test('rewriteMetaGprNames rewrites imports and optionalDependencies', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'fabric-gpr-'))
  try {
    fs.writeFileSync(path.join(tmp, 'platform.js'), "module.exports = '@qvac/fabric-linux-x64'\n")
    fs.writeFileSync(path.join(tmp, 'package.json'), JSON.stringify({
      name: '@qvac/fabric',
      version: '0.11.0',
      optionalDependencies: expectedOptionalDependencies('0.11.0'),
      imports: expectedImports()
    }, null, 2) + '\n')
    rewriteMetaGprNames(tmp, '0.11.0-tmp.runid-1')
    const manifest = JSON.parse(fs.readFileSync(path.join(tmp, 'package.json'), 'utf8'))
    assert.equal(manifest.optionalDependencies['@tetherto/fabric-linux-x64-mono'], '0.11.0-tmp.runid-1')
    assert.equal(manifest.imports['#binding'].linux.x64, '@tetherto/fabric-linux-x64-mono')
    assert.equal(manifest.imports['#binding'].ios, '@tetherto/fabric-ios-mono')
    assert.match(fs.readFileSync(path.join(tmp, 'platform.js'), 'utf8'), /@tetherto\/fabric-linux-x64-mono/)
    assert.doesNotMatch(fs.readFileSync(path.join(tmp, 'platform.js'), 'utf8'), /@qvac\/fabric-linux-x64/)
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true })
  }
})
