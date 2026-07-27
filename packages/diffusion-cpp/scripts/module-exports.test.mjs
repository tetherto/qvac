import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import test from 'node:test'

const require = createRequire(import.meta.url)

function mockBareModule(id, exports) {
  const filename = require.resolve(id)
  require.cache[filename] = { id: filename, filename, loaded: true, exports }
}

// The wrapper targets Bare, so substitute Node equivalents to exercise Node's
// CommonJS namespace discovery without loading Bare-only native modules.
mockBareModule('bare-os', require('node:os'))
mockBareModule('bare-path', require('node:path'))

const cjsModule = require('../index.js')

test('package root preserves CommonJS and ESM class exports in Node', async () => {
  const esmModule = await import('../index.js')

  assert.equal(cjsModule.ImgStableDiffusion, cjsModule)
  assert.equal(esmModule.default, cjsModule)
  assert.equal(esmModule.ImgStableDiffusion, cjsModule)
})
