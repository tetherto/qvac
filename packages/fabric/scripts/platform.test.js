'use strict'

const { test } = require('node:test')
const assert = require('node:assert/strict')
const { platformPackageName, runtimeHost } = require('../platform')

test('platformPackageName maps explicit hosts, including grouped mobile packages', () => {
  assert.equal(platformPackageName('linux', 'x64'), '@qvac/fabric-linux-x64')
  assert.equal(platformPackageName('darwin', 'arm64'), '@qvac/fabric-darwin-arm64')
  assert.equal(platformPackageName('ios', 'arm64'), '@qvac/fabric-ios')
  assert.equal(platformPackageName('android', 'arm64'), '@qvac/fabric-android-arm64')
  assert.equal(platformPackageName('plan9', 'x64'), null)
})

test('runtimeHost reads Node process without throwing', () => {
  const host = runtimeHost()
  assert.equal(typeof host.platform, 'string')
  assert.equal(typeof host.arch, 'string')
  assert.equal(platformPackageName(), platformPackageName(host.platform, host.arch))
})
