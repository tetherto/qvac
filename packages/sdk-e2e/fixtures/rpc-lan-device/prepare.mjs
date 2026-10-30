import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const output = process.argv[2]
const coordinator = process.env.QVAC_RPC_LAN_COORDINATOR
if (!output || !coordinator)
  throw new Error('Provide an output directory and QVAC_RPC_LAN_COORDINATOR')
if (fs.existsSync(output)) throw new Error('Use a new output directory for the validation app')
const parsed = new URL(coordinator)
if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:')
  throw new Error('Invalid coordinator URL')
const e2e = path.resolve(here, '../..')
const sdk = path.resolve(e2e, '../sdk')
const template = JSON.parse(
  fs.readFileSync(
    path.join(e2e, 'node_modules/@qvac/test-suite/templates/mobile-consumer/package.json.template')
  )
)
const pin = template.overrides?.['@qvac/inference']
if (!pin?.startsWith('file:'))
  throw new Error('Run npm run install:build:full first to pin the local inference build')
fs.mkdirSync(path.join(output, 'plugins'), { recursive: true })
const pkg = {
  name: 'qvac-rpc-lan-device-validation',
  version: '1.0.0',
  private: true,
  main: 'node_modules/expo/AppEntry.js',
  dependencies: {
    expo: '~54.0.33',
    react: '19.1.0',
    'react-native': '0.81.5',
    'react-native-bare-kit': '0.16.0',
    'expo-asset': '~12.0.13',
    'expo-build-properties': '^1.0.9',
    'expo-device': '~8.0.10',
    'expo-file-system': '~19.0.21',
    'expo-keep-awake': '~15.0.8',
    '@qvac/sdk': `file:${sdk}`
  },
  devDependencies: {
    '@babel/core': '^7.25.2',
    '@types/react': '^19.1.0',
    '@expo/config-plugins': '^54.0.4',
    typescript: '^5.9.3'
  },
  overrides: template.overrides
}
const write = (name, value) =>
  fs.writeFileSync(path.join(output, name), JSON.stringify(value, null, 2) + '\n')
write('package.json', pkg)
write('device-config.json', { coordinator: parsed.origin, engine: path.basename(pin) })
write('qvac.config.json', {
  plugins: ['@qvac/sdk/llamacpp-completion/plugin'],
  rpcServerProvider: '@qvac/sdk/ggml-rpc-server/provider',
  includeAudioDecoder: false,
  loggerConsoleOutput: true,
  loggerLevel: 'info'
})
write('app.json', {
  expo: {
    name: 'QVAC RPC LAN',
    slug: 'qvac-rpc-lan-device',
    version: '1.0.0',
    ios: {
      bundleIdentifier:
        process.env.QVAC_RPC_LAN_IOS_BUNDLE_ID ?? 'com.example.qvac.rpc.lanvalidation',
      ...(process.env.QVAC_IOS_TEAM_ID ? { appleTeamId: process.env.QVAC_IOS_TEAM_ID } : {}),
      infoPlist: {
        NSLocalNetworkUsageDescription:
          'Validate QVAC discovery and inference on your local Wi-Fi network.',
        NSAppTransportSecurity: { NSAllowsArbitraryLoads: true }
      }
    },
    android: {
      package: 'io.tether.qvac.rpc.lanvalidation',
      permissions: ['INTERNET', 'ACCESS_WIFI_STATE', 'CHANGE_WIFI_MULTICAST_STATE']
    },
    plugins: [
      ['@qvac/sdk/expo-plugin', { installMissingPrebuilds: true }],
      './plugins/withMulticastLock.cjs'
    ]
  }
})
fs.copyFileSync(path.join(here, 'App.tsx'), path.join(output, 'App.tsx'))
fs.copyFileSync(
  path.join(here, 'withMulticastLock.cjs'),
  path.join(output, 'plugins/withMulticastLock.cjs')
)
fs.writeFileSync(
  path.join(output, 'babel.config.js'),
  "module.exports = function(api) { api.cache(true); return {presets:[require.resolve('babel-preset-expo',{paths:[require.resolve('expo/package.json')]})]} }\n"
)
fs.writeFileSync(
  path.join(output, 'metro.config.js'),
  "const {getDefaultConfig}=require('expo/metro-config'); module.exports=getDefaultConfig(__dirname)\n"
)
fs.writeFileSync(path.join(output, '.npmrc'), 'install-links=true\n')
console.log(
  `Prepared ${output}. Install with npm install --install-links --ignore-scripts, then run expo prebuild.`
)
