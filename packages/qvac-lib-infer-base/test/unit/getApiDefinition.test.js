'use strict'

const test = require('brittle')
const { platform } = require('bare-os')
const getApiDefinition = require('../../src/getApiDefinition')

const expected = {
  android: 'vulkan',
  darwin: 'metal',
  ios: 'metal',
  win32: 'vulkan-32',
  linux: 'vulkan'
}

test('getApiDefinition - returns correct API for current platform', t => {
  t.is(getApiDefinition(), expected[platform()])
})
