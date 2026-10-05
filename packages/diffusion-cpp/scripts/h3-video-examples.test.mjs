import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import vm from 'node:vm'

test('H3 example creates an H3_OUTPUT parent before loading the model', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'h3-output-'))
  const output = path.join(root, 'new', 'nested', 'clip.avi')
  const source = fs.readFileSync(new URL('../examples/h3-video-common.js', import.meta.url), 'utf8')
  const env = { H3_OUTPUT: output }
  const fakeProcess = { env, on() {}, off() {} }
  const fakeFs = {
    ...fs,
    existsSync(file) {
      return file === output ? fs.existsSync(file) : true
    }
  }
  class FakeVideoStableDiffusion {
    async load() {
      assert.ok(fs.statSync(path.dirname(output)).isDirectory())
    }

    run() {
      return {
        on() {
          return this
        },
        onUpdate(callback) {
          callback(new Uint8Array([1, 2, 3]))
          return this
        },
        async await() {}
      }
    }

    async unload() {}
  }
  const module = { exports: {} }
  const context = {
    __dirname: path.join(root, 'examples'),
    module,
    Uint8Array,
    console: { log() {} },
    require(name) {
      if (name === 'bare-fs') return fakeFs
      if (name === 'bare-path') return path
      if (name === 'bare-process') return fakeProcess
      if (name === '../video') return FakeVideoStableDiffusion
      throw new Error(`Unexpected require: ${name}`)
    }
  }

  try {
    vm.runInNewContext(source, context)
    assert.equal(
      await module.exports.runH3Video({
        mode: 'txt2vid',
        prompt: 'boat',
        outputPath: env.H3_OUTPUT
      }),
      output
    )
    assert.deepEqual([...fs.readFileSync(output)], [1, 2, 3])
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})
