'use strict'

const { test } = require('node:test')
const assert = require('node:assert/strict')
const { PREBUILT_HOSTS, platformPackageName, runtimeHost } = require('../platform')
const { SLICES, npmPackageName } = require('./platform-slices')

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

// platform.js ships in the meta package and cannot require the slice table, so
// pin the two against each other here: a slice added to one and not the other
// would otherwise surface as a wrong package name in a runtime error.
test('platform.js agrees with the slice table on every published package name', () => {
  for (const slice of SLICES) {
    const [platform, arch] = slice.name === 'ios'
      ? ['ios', 'arm64']
      : slice.name.split('-')
    assert.equal(
      platformPackageName(platform, arch),
      npmPackageName(slice.name),
      `slice ${slice.name}`
    )
  }
})

test('PREBUILT_HOSTS covers every slice and nothing else', () => {
  const expected = SLICES.map((slice) => {
    if (slice.name === 'ios') return 'ios'
    if (slice.name === 'android-arm64') return 'android'
    return slice.name
  })
  assert.deepEqual([...PREBUILT_HOSTS].sort(), expected.sort())
})
