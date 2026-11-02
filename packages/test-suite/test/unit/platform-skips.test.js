import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { ConsumerBase } from '../../dist/core/consumer-base.js'

class Probe extends ConsumerBase {
  constructor(platform) {
    // The constructor only records what it is given; nothing here touches MQTT.
    super({}, 'probe', platform, 'run', {}, {})
  }
  reasonFor(platforms) {
    return this.getTestSkipReason({ testId: 't', skip: { reason: 'because', platforms } })
  }
  reasonOf(skip) {
    return this.getTestSkipReason({ testId: 't', skip })
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

// Two rules matched `vla-*`: one for the packaged pass, one for mobile. Each leg reports its own.
const merged = {
  reason: 'electron, snap: too slow for the packaged pass | mobile: OOM on device',
  platforms: ['electron', 'snap', 'mobile'],
  reasons: [
    { platforms: ['electron', 'snap'], reason: 'too slow for the packaged pass' },
    { platforms: ['mobile'], reason: 'OOM on device' }
  ]
}

test('a merged skip reports only the reasons for this platform', () => {
  assert.equal(new Probe('mobile-android').reasonOf(merged), 'OOM on device')
  assert.equal(new Probe('mobile-ios').reasonOf(merged), 'OOM on device')
  assert.equal(new Probe('electron-linux').reasonOf(merged), 'too slow for the packaged pass')
  assert.equal(new Probe('snap-linux').reasonOf(merged), 'too slow for the packaged pass')
})

test('every group matching this platform is reported', () => {
  const skip = {
    ...merged,
    reasons: [...merged.reasons, { platforms: ['mobile-android'], reason: 'flaky on Android' }]
  }
  assert.equal(new Probe('mobile-android').reasonOf(skip), 'OOM on device | flaky on Android')
  assert.equal(new Probe('mobile-ios').reasonOf(skip), 'OOM on device')
})

test('per-platform reasons never widen the skip', () => {
  const skip = { ...merged, platforms: ['mobile'] }
  assert.equal(new Probe('electron-linux').reasonOf(skip), null)
  assert.equal(new Probe('desktop-macos').reasonOf(merged), null)
})

test('a skip without per-platform reasons reports its reason', () => {
  const { reasons, ...plain } = merged
  assert.equal(new Probe('mobile-android').reasonOf(plain), merged.reason)
  assert.equal(new Probe('mobile-android').reasonOf({ ...merged, reasons: [] }), merged.reason)
})

test('a platform with no matching group falls back to the reason', () => {
  const skip = { ...merged, reasons: [merged.reasons[0]] }
  assert.equal(new Probe('mobile-android').reasonOf(skip), merged.reason)
})

test('a JS consumer registers a label the per-OS rules can reach', async () => {
  const { hostOs, hostPlatform } = await import('../../dist/cli/utils/host-platform.js')
  const everyOs = ['macos', 'windows', 'linux']

  assert.ok(everyOs.includes(hostOs()), 'the host this runs on maps to a known OS')

  for (const family of ['desktop', 'electron']) {
    for (const [host, os] of [
      ['darwin', 'macos'],
      ['win32', 'windows'],
      ['linux', 'linux']
    ]) {
      const label = hostPlatform(family, host)
      assert.equal(label, `${family}-${os}`)
      // The label is only worth anything if the matcher agrees: the family rule still reaches it,
      // and a rule for one of the other two does not.
      assert.equal(skips(label, [family]), true, `${label} vs ${family}`)
      const otherOs = everyOs.filter((o) => o !== os).map((o) => `${family}-${o}`)
      assert.equal(skips(label, otherOs), false, `${label} vs ${otherOs.join()}`)
      assert.equal(skips(label, [`${family}-${os}`]), true, `${label} vs its own OS`)
    }
  }
})

test('the desktop consumer takes no platform default from the CLI', () => {
  const cli = fileURLToPath(new URL('../../dist/cli/index.js', import.meta.url))
  const help = spawnSync(process.execPath, [cli, 'run:consumer:desktop', '--help'], {
    encoding: 'utf8'
  }).stdout
  const option = help.split('\n').find((line) => line.includes('--platform'))

  assert.ok(option, 'the option is still there')
  // A default here wins over the runner's `desktop-<os>` fallback, which is how the bare family
  // reached every leg before. Commander prints one as `(default: ...)`.
  assert.ok(!option.includes('default'), `--platform must carry no default: ${option.trim()}`)
})
