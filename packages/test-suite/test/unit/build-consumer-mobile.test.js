import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  collectHostAddonPackages,
  resolvePlatformPackageName,
  selectMobilePlatformPackages
} from '../../dist/cli/commands/build-consumer-mobile.js'

const NO_LOCAL_PREBUILDS = '/nonexistent/node_modules'

function hostAddonMap(metaName) {
  return {
    linux: {
      x64: [`${metaName}-linux-x64`, './addon-unavailable.js'],
      default: './addon-unavailable.js'
    },
    android: {
      arm64: [`${metaName}-android-arm64`, './addon-unavailable.js'],
      default: './addon-unavailable.js'
    },
    ios: [`${metaName}-ios`, './addon-unavailable.js'],
    default: './addon-unavailable.js'
  }
}

function splitAddon(name, version) {
  return {
    name,
    version,
    hostAddon: hostAddonMap(name),
    packageRoot: `${NO_LOCAL_PREBUILDS}/${name}`
  }
}

function speechAddons() {
  return [
    splitAddon('@qvac/tts-ggml', '0.9.2'),
    splitAddon('@qvac/audiogen-ggml', '0.4.1'),
    splitAddon('@qvac/asr-ggml', '0.5.2')
  ]
}

test('android builds select only the android slice of every split addon', () => {
  const additions = selectMobilePlatformPackages('android', speechAddons(), {})

  assert.deepEqual(Object.keys(additions).sort(), [
    '@qvac/asr-ggml',
    '@qvac/asr-ggml-android-arm64',
    '@qvac/audiogen-ggml',
    '@qvac/audiogen-ggml-android-arm64',
    '@qvac/tts-ggml',
    '@qvac/tts-ggml-android-arm64'
  ])
  assert.equal(
    Object.keys(additions).some((name) => name.endsWith('-ios')),
    false,
    'an android build must not pull iOS binaries'
  )
})

test('ios builds collapse every ios flavour onto one slice per addon', () => {
  const additions = selectMobilePlatformPackages('ios', speechAddons(), {})

  assert.deepEqual(Object.keys(additions).sort(), [
    '@qvac/asr-ggml',
    '@qvac/asr-ggml-ios',
    '@qvac/audiogen-ggml',
    '@qvac/audiogen-ggml-ios',
    '@qvac/tts-ggml',
    '@qvac/tts-ggml-ios'
  ])
  assert.equal(
    Object.keys(additions).some((name) => name.endsWith('-android-arm64')),
    false,
    'an ios build must not pull Android binaries'
  )
})

test('the slice and its meta package are pinned to one exact version', () => {
  const additions = selectMobilePlatformPackages('android', speechAddons(), {})

  assert.equal(additions['@qvac/tts-ggml-android-arm64'], '0.9.2')
  assert.equal(additions['@qvac/tts-ggml'], '0.9.2')
  for (const spec of Object.values(additions)) {
    assert.doesNotMatch(spec, /[\^~]/, 'a range could pair a slice with a different JS layer')
  }
})

test('addons resolved from a local path are left alone', () => {
  const additions = selectMobilePlatformPackages('android', speechAddons(), {
    '@qvac/tts-ggml': 'file:../../tts-ggml'
  })

  assert.equal(additions['@qvac/tts-ggml-android-arm64'], undefined)
  assert.equal(additions['@qvac/tts-ggml'], undefined)
  assert.equal(additions['@qvac/audiogen-ggml-android-arm64'], '0.4.1')
})

test('an addon the consumer pins to a range keeps its own resolution', () => {
  const additions = selectMobilePlatformPackages('android', speechAddons(), {
    '@qvac/tts-ggml': '^0.9.1'
  })

  assert.equal(
    additions['@qvac/tts-ggml-android-arm64'],
    undefined,
    'a floating addon must not be paired with an exactly pinned slice'
  )
  assert.equal(additions['@qvac/audiogen-ggml-android-arm64'], '0.4.1')
})

test('an addon the consumer pins to the installed version still gets its slice', () => {
  const additions = selectMobilePlatformPackages('android', speechAddons(), {
    '@qvac/tts-ggml': '0.9.2'
  })

  assert.equal(additions['@qvac/tts-ggml-android-arm64'], '0.9.2')
  assert.equal(additions['@qvac/tts-ggml'], undefined)
})

test('pre-split addons carry no host-addon map and are skipped', () => {
  const preSplit = {
    name: '@qvac/asr-ggml',
    version: '0.3.7',
    hostAddon: undefined,
    packageRoot: `${NO_LOCAL_PREBUILDS}/@qvac/asr-ggml`
  }

  assert.deepEqual(selectMobilePlatformPackages('android', [preSplit], {}), {})
})

test('dependencies the consumer already declares are never overwritten', () => {
  const additions = selectMobilePlatformPackages('ios', speechAddons(), {
    '@qvac/tts-ggml-ios': '0.9.0'
  })

  assert.equal(additions['@qvac/tts-ggml-ios'], undefined)
})

test('an addon with no package for the target platform is skipped', () => {
  const desktopOnly = {
    name: '@qvac/desktop-only',
    version: '1.0.0',
    hostAddon: {
      linux: { x64: ['@qvac/desktop-only-linux-x64', './addon-unavailable.js'] },
      android: { arm64: './addon-unavailable.js' },
      default: './addon-unavailable.js'
    },
    packageRoot: `${NO_LOCAL_PREBUILDS}/@qvac/desktop-only`
  }

  assert.deepEqual(selectMobilePlatformPackages('android', [desktopOnly], {}), {})
  assert.deepEqual(selectMobilePlatformPackages('ios', [desktopOnly], {}), {})
})

test('a pnpm install still selects the fabric slice of a transitive dependency', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qvac-mobile-pnpm-'))
  try {
    const configDir = path.join(root, 'app')
    const store = path.join(configDir, 'node_modules', '.pnpm', 'llm@0.55.0', 'node_modules')
    writePackage(path.join(store, '@qvac', 'llm-llamacpp'), {
      name: '@qvac/llm-llamacpp',
      version: '0.55.0',
      dependencies: { '@qvac/fabric': '0.18.0' },
      imports: { '#host-addon': hostAddonMap('@qvac/llm-llamacpp') }
    })
    writePackage(path.join(store, '@qvac', 'fabric'), {
      name: '@qvac/fabric',
      version: '0.18.0',
      dependencies: { '@qvac/llm-llamacpp': '0.55.0' },
      imports: { '#host-addon': hostAddonMap('@qvac/fabric') }
    })
    const topLlm = path.join(configDir, 'node_modules', '@qvac', 'llm-llamacpp')
    fs.mkdirSync(path.dirname(topLlm), { recursive: true })
    fs.symlinkSync(path.join(store, '@qvac', 'llm-llamacpp'), topLlm)

    const additions = selectMobilePlatformPackages('android', collectHostAddonPackages(configDir), {
      '@qvac/llm-llamacpp': '0.55.0'
    })

    assert.equal(additions['@qvac/fabric-android-arm64'], '0.18.0')
    assert.equal(additions['@qvac/fabric'], '0.18.0')
    assert.equal(additions['@qvac/llm-llamacpp-android-arm64'], '0.55.0')
    assert.equal(fs.existsSync(path.join(configDir, 'node_modules', '@qvac', 'fabric')), false)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('an npm-nested fabric install is selected from the addon that depends on it', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qvac-mobile-nested-'))
  try {
    const configDir = path.join(root, 'app')
    const llmDir = path.join(configDir, 'node_modules', '@qvac', 'llm-llamacpp')
    writePackage(llmDir, {
      name: '@qvac/llm-llamacpp',
      version: '0.55.0',
      dependencies: { '@qvac/fabric': '0.18.0' },
      imports: { '#host-addon': hostAddonMap('@qvac/llm-llamacpp') }
    })
    writePackage(path.join(llmDir, 'node_modules', '@qvac', 'fabric'), {
      name: '@qvac/fabric',
      version: '0.18.0',
      imports: { '#host-addon': hostAddonMap('@qvac/fabric') }
    })

    const additions = selectMobilePlatformPackages('ios', collectHostAddonPackages(configDir), {
      '@qvac/llm-llamacpp': '0.55.0'
    })

    assert.equal(additions['@qvac/fabric-ios'], '0.18.0')
    assert.equal(additions['@qvac/llm-llamacpp-ios'], '0.55.0')
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

function writePackage(dir, manifest) {
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify(manifest))
}

test('resolvePlatformPackageName reads the addon own imports map', () => {
  const map = hostAddonMap('@qvac/tts-ggml')

  assert.equal(resolvePlatformPackageName(map, 'android'), '@qvac/tts-ggml-android-arm64')
  assert.equal(resolvePlatformPackageName(map, 'ios'), '@qvac/tts-ggml-ios')
  assert.equal(resolvePlatformPackageName(undefined, 'android'), undefined)
  assert.equal(resolvePlatformPackageName({ android: 'x' }, 'android'), undefined)
})
