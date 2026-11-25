import test from 'brittle'
import type { ExportedConfig } from '@expo/config-plugins'
import type { ExpoConfig } from 'expo/config'
import fs from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import {
  EXPO_BARE_KIT_ENTRY,
  EXPO_BARE_KIT_WORKER,
  MOBILE_HOSTS,
  MOBILE_WORKER_ENTRY,
  qvacWorkerOptions
} from '@/expo/plugins/mobile-worker'
import withExpoBareKit, { findExpoBareKit } from '@/expo/plugins/withExpoBareKit'
import { installFakePackageManager, withPath } from './fixtures/fake-package-manager'
import { createSplitAddonProject } from './fixtures/split-addon-project'

const posixOnly = { skip: process.platform === 'win32' }

const CONFIG_PLUGINS = createRequire(import.meta.url).resolve('@expo/config-plugins')

/**
 * Installs an expo-bare-kit that records each application's options and, like
 * the real one, adds its link mod on the first. The mod records whether the
 * SDK worker entries exist when it runs.
 */
function installFakeExpoBareKit(projectRoot: string, version: string) {
  const dir = path.join(projectRoot, 'node_modules', 'expo-bare-kit')
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(
    path.join(dir, 'package.json'),
    JSON.stringify({ name: 'expo-bare-kit', version, main: 'app.plugin.js' })
  )
  fs.writeFileSync(
    path.join(dir, 'app.plugin.js'),
    `const fs = require('fs')
const path = require('path')
const { withDangerousMod } = require(${JSON.stringify(CONFIG_PLUGINS)})

module.exports = function withBareKit(config, opts) {
  const recorded = config._internal.expoBareKit
  config._internal.expoBareKit = [...(recorded ?? []), opts]
  if (recorded !== undefined) return config
  return withDangerousMod(config, ['android', (mod) => {
    const entries = ${JSON.stringify([EXPO_BARE_KIT_ENTRY, MOBILE_WORKER_ENTRY])}
    mod._internal.entryAtLink = entries.every((entry) =>
      fs.existsSync(path.join(mod.modRequest.projectRoot, entry))
    )
    return mod
  }])
}
`
  )
  return dir
}

function appConfig(projectRoot: string): ExpoConfig {
  return { name: 'app', slug: 'app', _internal: { projectRoot } }
}

async function runAndroidMods(config: ExportedConfig, projectRoot: string) {
  const dangerous = config.mods!.android!.dangerous!
  return (await dangerous({
    ...config,
    modResults: null,
    modRequest: {
      projectRoot,
      platformProjectRoot: path.join(projectRoot, 'android'),
      platform: 'android',
      modName: 'dangerous',
      introspect: false
    }
  } as never)) as ExpoConfig
}

test('qvacWorkerOptions: the phone hosts, the SDK import map and its deferred modules', (t) => {
  const project = createSplitAddonProject(path.join('node_modules', '@qvac', 'sdk'))
  t.teardown(project.cleanup)

  const options = qvacWorkerOptions(project.projectRoot)

  t.alike(options.hosts, MOBILE_HOSTS)
  t.alike(options.defer, ['expo-file-system', 'react-native-bare-kit', '@qvac/sdk/worker.mobile'])
  t.alike(options, qvacWorkerOptions(project.projectRoot), 'every call gives equal options')
})

test('findExpoBareKit: finds an installed expo-bare-kit', (t) => {
  const project = createSplitAddonProject(path.join('node_modules', '@qvac', 'sdk'))
  t.teardown(project.cleanup)

  t.is(findExpoBareKit(project.projectRoot), null)
  const dir = installFakeExpoBareKit(project.projectRoot, '0.3.1')
  t.is(findExpoBareKit(project.projectRoot), dir)
})

test('withExpoBareKit: adds the SDK worker to expo-bare-kit', (t) => {
  const project = createSplitAddonProject(path.join('node_modules', '@qvac', 'sdk'))
  t.teardown(project.cleanup)
  const expoBareKitDir = installFakeExpoBareKit(project.projectRoot, '0.3.1')

  const config = withExpoBareKit(appConfig(project.projectRoot), {
    projectRoot: project.projectRoot,
    expoBareKitDir
  })

  t.alike(config._internal!['expoBareKit'], [
    { workers: [[EXPO_BARE_KIT_ENTRY, qvacWorkerOptions(project.projectRoot)]] }
  ])
})

test('withExpoBareKit: refuses an expo-bare-kit older than 0.3.1', (t) => {
  const project = createSplitAddonProject(path.join('node_modules', '@qvac', 'sdk'))
  t.teardown(project.cleanup)
  const expoBareKitDir = installFakeExpoBareKit(project.projectRoot, '0.3.0')

  t.exception(
    () =>
      withExpoBareKit(appConfig(project.projectRoot), {
        projectRoot: project.projectRoot,
        expoBareKitDir
      }),
    /needs 0\.3\.1 or later/
  )
})

for (const order of ['app first', 'SDK first'] as const) {
  test(
    `withExpoBareKit: writes the worker entry before expo-bare-kit links it (${order})`,
    posixOnly,
    async (t) => {
      const project = createSplitAddonProject(path.join('node_modules', '@qvac', 'sdk'))
      t.teardown(project.cleanup)
      const pm = installFakePackageManager(project.projectRoot, 'pnpm')
      const expoBareKitDir = installFakeExpoBareKit(project.projectRoot, '0.3.1')
      const withExpoBareKitPlugin = createRequire(path.join(expoBareKitDir, 'package.json'))(
        './app.plugin.js'
      ) as (config: ExpoConfig, opts: unknown) => ExpoConfig
      const withApp = (config: ExpoConfig) => withExpoBareKitPlugin(config, { workers: ['app.js'] })
      const withSdk = (config: ExpoConfig) =>
        withExpoBareKit(config, {
          projectRoot: project.projectRoot,
          expoBareKitDir,
          installMissingPrebuilds: true
        })

      const configured =
        order === 'app first'
          ? withSdk(withApp(appConfig(project.projectRoot)))
          : withApp(withSdk(appConfig(project.projectRoot)))
      const result = await withPath(pm.binDir, () =>
        runAndroidMods(configured, project.projectRoot)
      )

      t.is(result._internal!['entryAtLink'], true)
      t.is(
        fs.readFileSync(path.join(project.sdkPath, 'dist', 'worker-mobile', 'index.js'), 'utf8'),
        `export { default } from '${EXPO_BARE_KIT_WORKER}'\n`,
        '@qvac/sdk/worker.mobile re-exports the worker expo-bare-kit packs'
      )
      t.absent(
        fs.existsSync(path.join(project.sdkPath, 'dist', 'worker-mobile', 'index.bundle.mjs')),
        'the SDK bundle is not shipped'
      )
      t.absent(
        fs.existsSync(path.join(project.projectRoot, 'android', 'qvac-bare-kit')),
        'the SDK adds no Bare Kit of its own'
      )
    }
  )
}

test('withExpoBareKit: asks for a clean prebuild over the SDK Bare Kit module', async (t) => {
  const project = createSplitAddonProject(path.join('node_modules', '@qvac', 'sdk'))
  t.teardown(project.cleanup)
  const expoBareKitDir = installFakeExpoBareKit(project.projectRoot, '0.3.1')
  fs.mkdirSync(path.join(project.projectRoot, 'android', 'qvac-bare-kit'), { recursive: true })

  const configured = withExpoBareKit(appConfig(project.projectRoot), {
    projectRoot: project.projectRoot,
    expoBareKitDir
  })

  await t.exception(runAndroidMods(configured, project.projectRoot), /npx expo prebuild --clean/)
})

test('withExpoBareKit: refuses a config that leaves the audio decoder out', async (t) => {
  const project = createSplitAddonProject(path.join('node_modules', '@qvac', 'sdk'))
  t.teardown(project.cleanup)
  const expoBareKitDir = installFakeExpoBareKit(project.projectRoot, '0.3.1')
  const config = JSON.parse(fs.readFileSync(project.configPath, 'utf8'))
  fs.writeFileSync(project.configPath, JSON.stringify({ ...config, includeAudioDecoder: false }))

  const configured = withExpoBareKit(appConfig(project.projectRoot), {
    projectRoot: project.projectRoot,
    expoBareKitDir
  })

  await t.exception(runAndroidMods(configured, project.projectRoot), /includeAudioDecoder: false/)
})

test(
  'withExpoBareKit: the entry expo-bare-kit requires starts the ES module worker entry',
  posixOnly,
  async (t) => {
    const project = createSplitAddonProject(path.join('node_modules', '@qvac', 'sdk'))
    t.teardown(project.cleanup)
    const pm = installFakePackageManager(project.projectRoot, 'pnpm')
    const expoBareKitDir = installFakeExpoBareKit(project.projectRoot, '0.3.1')
    const configured = withExpoBareKit(appConfig(project.projectRoot), {
      projectRoot: project.projectRoot,
      expoBareKitDir,
      installMissingPrebuilds: true
    })
    await withPath(pm.binDir, () => runAndroidMods(configured, project.projectRoot))

    fs.writeFileSync(
      path.join(project.projectRoot, MOBILE_WORKER_ENTRY),
      'await Promise.resolve()\nexport default function start(ipc, ready) { ready(); return ipc }\n'
    )
    const start = createRequire(import.meta.url)(
      path.join(project.projectRoot, EXPO_BARE_KIT_ENTRY)
    ) as (ipc: unknown, ready: () => void) => Promise<unknown>

    let readied = false
    t.is(await start('ipc', () => (readied = true)), 'ipc', 'it returns what the entry returns')
    t.ok(readied, 'the entry is started after its top-level await')
  }
)
