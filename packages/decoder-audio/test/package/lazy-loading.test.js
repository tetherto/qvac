'use strict'

const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const test = require('node:test')
const vm = require('node:vm')

test('decoder import works without FFmpeg and load reports a missing addon', async () => {
  const exports = {}
  const source = fs.readFileSync(path.join(__dirname, '..', '..', 'index.js'), 'utf8')
  let addonLoads = 0
  const requireModule = (specifier) => {
    if (specifier === 'bare-ffmpeg') {
      addonLoads++
      throw new Error('bare-ffmpeg is unavailable')
    }
    if (specifier === '@qvac/logging') {
      return class {
        info() {}
      }
    }
    if (specifier === '@qvac/infer-base') {
      return { QvacResponse: class {}, createJobHandler: () => ({}) }
    }
    if (specifier === './utils/error') {
      return {}
    }
    throw new Error(`Unexpected module: ${specifier}`)
  }

  vm.runInNewContext(source, { exports, require: requireModule })
  assert.equal(addonLoads, 0)
  const decoder = new exports.FFmpegDecoder()
  await assert.rejects(decoder.load(), /bare-ffmpeg is unavailable/)
  assert.equal(addonLoads, 1)
})
