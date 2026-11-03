'use strict'

const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const test = require('node:test')

const root = path.resolve(__dirname, '../..')

test('JavaScript packages do not enable or distribute Hexagon', () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(root, 'vcpkg.json'), 'utf8'))
  const cmake = fs.readFileSync(path.join(root, 'CMakeLists.txt'), 'utf8')
  assert.equal(manifest.features.hexagon, undefined)
  assert.doesNotMatch(cmake, /HEXAGON|stage_hexagon|libggml-htp/)
})
