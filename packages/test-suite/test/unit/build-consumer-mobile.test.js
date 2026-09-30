import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { generateAppJson } from '../../dist/cli/commands/build-consumer-mobile.js'

// Set so generateAppJson does not query the macOS keychain for a team ID.
process.env.QVAC_IOS_TEAM_ID = 'TESTTEAM01'

function generatedPlugins(userPlugins) {
  const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qvac-mobile-app-json-'))
  try {
    generateAppJson(outputDir, 'android', userPlugins)
    const appJson = JSON.parse(fs.readFileSync(path.join(outputDir, 'app.json'), 'utf-8'))
    return appJson.expo.plugins
  } finally {
    fs.rmSync(outputDir, { recursive: true, force: true })
  }
}

test('passes an Expo plugin and its options through to app.json', () => {
  const plugins = generatedPlugins([['@qvac/sdk/expo-plugin', { installMissingPrebuilds: true }]])

  assert.deepEqual(
    plugins.find((plugin) => Array.isArray(plugin) && plugin[0] === '@qvac/sdk/expo-plugin'),
    ['@qvac/sdk/expo-plugin', { installMissingPrebuilds: true }],
    'the SDK plugin receives the options the consumer config sets'
  )
})

test('inserts user plugins before expo-asset', () => {
  const plugins = generatedPlugins(['@qvac/sdk/expo-plugin'])

  assert.ok(plugins.indexOf('@qvac/sdk/expo-plugin') !== -1)
  assert.ok(plugins.indexOf('@qvac/sdk/expo-plugin') < plugins.indexOf('expo-asset'))
})
