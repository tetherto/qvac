'use strict'

const { platform } = require('bare-os')

const platformDefinitions = {
  android: 'vulkan',
  darwin: 'metal',
  ios: 'metal',
  win32: 'vulkan-32',
  linux: 'vulkan'
}

function getApiDefinition () {
  return platformDefinitions[platform()] ?? 'vulkan'
}

module.exports = getApiDefinition
