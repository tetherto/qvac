import { test } from 'node:test'
import assert from 'node:assert/strict'
import { ConsumerBase } from '../../dist/core/consumer-base.js'

class Probe extends ConsumerBase {
  constructor(platform) {
    // The constructor only records what it is given; nothing here touches MQTT.
    super({}, 'probe', platform, 'run', {}, {})
  }
  reasonFor(platforms) {
    return this.getTestSkipReason({ testId: 't', skip: { reason: 'because', platforms } })
  }
}

const skips = (platform, platforms) => new Probe(platform).reasonFor(platforms) !== null

test('an exact platform matches', () => {
  assert.equal(skips('mobile-ios', ['mobile-ios']), true)
  assert.equal(skips('mobile-ios', ['mobile-android']), false)
})

test('a coarse entry widens over the OS', () => {
  assert.equal(skips('mobile-ios', ['mobile']), true)
  assert.equal(skips('electron-linux', ['electron']), true)
  assert.equal(skips('desktop-macos', ['desktop']), true)
})

test('a coarse entry does not widen onto another client', () => {
  assert.equal(
    skips('desktop-python', ['desktop']),
    false,
    'desktop-python is a different client, not a desktop OS'
  )
  assert.equal(skips('desktop-python', ['desktop-python']), true)
})

test('a longer entry never matches a shorter platform', () => {
  assert.equal(skips('desktop', ['desktop-macos']), false)
})

test('matching is by segment, not by string prefix', () => {
  assert.equal(skips('desktop-macos', ['desk']), false)
  assert.equal(skips('snap-linux', ['electron']), false)
})

test('no declared platforms is not a platform skip', () => {
  assert.equal(new Probe('desktop-macos').reasonFor(undefined), null)
  assert.equal(new Probe('desktop-macos').reasonFor([]), null)
})

test('a JS consumer registers a label that carries its OS', async () => {
  const { hostOs, hostPlatform } = await import('../../dist/cli/utils/host-platform.js')

  assert.ok(['macos', 'linux', 'windows'].includes(hostOs()))
  assert.equal(hostPlatform('desktop'), `desktop-${hostOs()}`)

  // Why the suffix matters: a per-OS rule reaches no leg that registers the bare family.
  assert.equal(skips(hostPlatform('desktop'), [`desktop-${hostOs()}`]), true)
  assert.equal(skips('desktop', ['desktop-macos']), false)
})
