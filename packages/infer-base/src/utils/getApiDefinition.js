'use strict'

const { platform } = require('bare-os')

const platformDefinitions = {
  android: 'vulkan',
  darwin: 'metal',
  ios: 'metal',
  win32: 'vulkan-32',
  linux: 'vulkan'
}

/**
 * Returns the graphics API identifier for the current platform.
 * Falls back to 'vulkan' on unknown platforms.
 *
 * @returns {string} One of 'vulkan', 'metal', 'vulkan-32'
 */
function getApiDefinition () {
  return platformDefinitions[platform()] ?? 'vulkan'
}

module.exports = getApiDefinition
