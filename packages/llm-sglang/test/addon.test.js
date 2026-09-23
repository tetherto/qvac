const { describe, it } = require('node:test')
const assert = require('node:assert/strict')
const Module = require('node:module')
const path = require('node:path')

// @qvac/infer-base loads bare-os, whose binding only exists inside Bare.
// The cases here never enter the native SGLang module.
const originalRequire = Module.prototype.require
Module.prototype.require = function (id) {
  if (id.startsWith('.') && this.filename) {
    const resolved = path.resolve(path.dirname(this.filename), id)
    if (resolved.endsWith(`${path.sep}bare-os${path.sep}binding`)) {
      return { platform: 'linux', arch: 'x64', signals: {}, errnos: {} }
    }
  }
  return originalRequire.apply(this, arguments)
}

const LlmSglang = require('..')

describe('LlmSglang', () => {
  it('rejects a run before the server is started', () => {
    const addon = new LlmSglang()
    assert.throws(
      () => addon.run([{ role: 'user', content: 'hello' }]),
      /SGLang server is not started/
    )
  })

  it('rejects a prompt that is not a message list', () => {
    const addon = new LlmSglang()
    assert.throws(() => addon.run('hello'), /Message\[\]/)
    assert.throws(() => addon.run([]), /must not be empty/)
  })

  it('rejects audio and video before talking to the server', () => {
    const addon = new LlmSglang()
    assert.throws(
      () => addon.run([{ role: 'user', type: 'audio', content: 'clip.wav' }]),
      /audio inputs are not supported/
    )
    assert.throws(
      () => addon.run([{ role: 'user', type: 'media', content: 'clip.mp4' }]),
      /video inputs are not supported/
    )
  })

  it('refuses to load without a model path or a base URL', async () => {
    const addon = new LlmSglang()
    await assert.rejects(addon.load(), /files\.model or config\.baseUrl/)
  })
})
