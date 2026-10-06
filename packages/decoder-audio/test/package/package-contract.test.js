'use strict'

const assert = require('node:assert/strict')
const test = require('node:test')
const packageJson = require('../../package.json')

test('decoder shares the infer-base dependency range of the inference packages', () => {
  assert.equal(packageJson.dependencies['@qvac/infer-base'], '^0.6.2')
})
