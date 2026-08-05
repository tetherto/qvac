import test from 'brittle'
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import Bundle from 'bare-bundle'
import {
  buildSyncReactNativeBundle,
  createSyncReactNativeDescriptor,
  syncReactNativeHosts
} from '../lib/react-native-stow.ts'
import { createReactNativeSyncLauncher } from '../lib/react-native-launcher.ts'
import { createSyncMobileEntry } from '../mobile-entry.ts'
import { encodeSyncConfig, resolveSyncConfig } from '../lib/config.ts'

test('sync react-native descriptor uses package-owned generated paths', async (t) => {
  const descriptor = createSyncReactNativeDescriptor()
  t.ok(
    descriptor.entryPath.endsWith('/packages/sync/mobile-entry.ts'),
    'entry points to the package-owned mobile worker'
  )
  t.ok(
    descriptor.harnessPath.endsWith('/packages/sync/generated/react-native/sync.js'),
    'harness path is stable and package-owned'
  )
  t.ok(
    descriptor.metadataPath.endsWith('/packages/sync/generated/react-native/sync.metadata.json'),
    'metadata path is stable and package-owned'
  )
  t.is(descriptor.contract, 'qvac.sync')
  t.is(descriptor.protocolVersion, 1)
  t.alike(descriptor.hosts, syncReactNativeHosts)
})

test('sync react-native descriptor tracks latest stow dependencies', async (t) => {
  const packageJson = JSON.parse(
    await readFile(new URL('../package.json', import.meta.url), 'utf8')
  ) as {
    readonly dependencies: Record<string, string>
    readonly peerDependencies: Record<string, string>
  }
  t.is(packageJson.dependencies['bare-stow'], '0.1.5')
  t.is(packageJson.dependencies['bare-stow-target-react-native'], '0.1.1')
  t.is(packageJson.dependencies['react-native-bare-kit'], undefined)
  t.is(packageJson.peerDependencies['react-native-bare-kit'], '^0.14.0')
})

test('sync react-native launcher passes runtime values as argv', async (t) => {
  const starts: Array<{ id: string; opts: object; args: string[] }> = []
  const launcher = createReactNativeSyncLauncher({
    startHarness: async (id, opts, args) => {
      starts.push({ id, opts: opts ?? {}, args: [...(args ?? [])] })
      return {
        ipc: {
          on() {
            return this
          },
          removeListener() {
            return this
          },
          once() {
            return this
          },
          write() {
            return true
          }
        },
        worklet: { terminate() {} }
      }
    },
    createClient() {
      return {
        ready: async () => {},
        close: async () => {}
      }
    }
  })

  await launcher.launch({
    storagePath: '/tmp/mobile-sync',
    bootstrap: [{ host: '127.0.0.1', port: 49737 }],
    meshSeed: Buffer.alloc(32, 1),
    meshKey: Buffer.alloc(32, 2),
    pairingInvite: Buffer.from('fbff0001', 'hex'),
    config: resolveSyncConfig({ level: 'error' }, {}),
    onDisconnect() {}
  })
  t.is(starts.length, 1)
  t.alike(starts[0], {
    id: 'Sync',
    opts: {},
    args: [
      'react-native-bare-kit',
      'sync.js',
      `{"storagePath":"/tmp/mobile-sync","bootstrap":[{"host":"127.0.0.1","port":49737}],"meshSeed":"${'01'.repeat(32)}","meshKey":"${'02'.repeat(32)}","pairingInvite":"fbff0001","config":"{\\"version\\":1,\\"values\\":{\\"logging.level\\":\\"error\\"}}"}`
    ]
  })
})

test('sync react-native launcher owns client and worklet lifecycle', async (t) => {
  const calls: string[] = []
  const launcher = createReactNativeSyncLauncher({
    startHarness: async () => {
      return {
        ipc: {
          on() {
            return this
          },
          removeListener() {
            return this
          },
          once() {
            return this
          },
          write() {
            return true
          }
        },
        worklet: { terminate() {} }
      }
    },
    createClient() {
      return {
        ready: async () => {
          calls.push('ready')
        },
        close: async () => {
          calls.push('close')
        }
      }
    }
  })

  const launched = await launcher.launch({
    storagePath: '/tmp/mobile-sync',
    config: resolveSyncConfig(undefined, {}),
    onDisconnect() {}
  })
  await launched.backend.ready()
  await launched.backend.close()
  launched.terminate()

  t.alike(calls, ['ready', 'close'])
})

test('sync mobile entry reads runtime argv and returns cleanup', async (t) => {
  const stream = {
    once() {},
    on() {},
    write() {
      return true
    },
    destroy() {}
  }
  const calls: string[] = []
  let nextArgv = [
    'bare',
    'sync.bundle',
    JSON.stringify({
      storagePath: '/tmp/sync',
      pairingInvite: 'fbff0001',
      config: encodeSyncConfig(resolveSyncConfig(undefined, {}))
    })
  ]
  const entry = createSyncMobileEntry({
    readArgv() {
      return nextArgv
    },
    markerExists: async () => true,
    createCore(options) {
      calls.push(`core:${options.storagePath}`)
      return {
        writable: true,
        async ready() {
          calls.push('ready')
        },
        connect(value: unknown) {
          calls.push(value === stream ? 'connect' : 'connect-wrong')
        },
        async close() {
          calls.push('close')
        }
      } as never
    },
    createStream() {
      calls.push('stream')
      return stream as never
    },
    ensureStorage: async () => {
      calls.push('mkdir')
    },
    writeMarker: async () => {
      calls.push('marker')
    }
  })
  let readyCalls = 0
  const stop = await entry({} as never, () => {
    readyCalls += 1
  })
  t.is(readyCalls, 1)
  t.is(typeof stop, 'function')
  await stop()
  t.alike(calls, ['core:/tmp/sync', 'ready', 'mkdir', 'marker', 'stream', 'connect', 'close'])
  nextArgv = [
    'bare',
    'sync.bundle',
    JSON.stringify({
      storagePath: '/tmp/sync-next',
      config: encodeSyncConfig(resolveSyncConfig(undefined, {}))
    })
  ]
  await entry({} as never, () => {})
  t.alike(calls.slice(7, 10), ['core:/tmp/sync-next', 'ready', 'mkdir'])
})

test('sync bundle build patches generated harness for argv', async (t) => {
  const outputDirectory = await mkdtemp(path.join(os.tmpdir(), 'sync-rn-stow-'))
  const build = await buildSyncReactNativeBundle({
    outputDirectory
  })
  const harnessSource = await readFile(build.descriptor.harnessPath, 'utf8')
  const declarationSource = await readFile(
    build.descriptor.harnessPath.replace(/\.js$/, '.d.ts'),
    'utf8'
  )
  t.ok(harnessSource.includes('args = []'), 'generated launcher accepts args')
  t.ok(
    harnessSource.includes("worklet.start('/core.bundle', bundle, args)"),
    'generated launcher forwards argv to Worklet.start'
  )
  t.ok(
    harnessSource.includes('const worklet = new Worklet(opts)'),
    'launcher keeps official target behavior and extends argv delivery only'
  )
  t.ok(
    declarationSource.includes('args?: readonly string[]'),
    'generated declaration includes optional argv argument'
  )
})

test('sync build produces launcher that delivers argv to Worklet.start', async (t) => {
  const outputDirectory = await mkdtemp(path.join(os.tmpdir(), 'sync-rn-runtime-'))
  const build = await buildSyncReactNativeBundle({ outputDirectory })
  const nodeModules = path.join(outputDirectory, 'node_modules')
  await mkdir(path.join(nodeModules, 'react-native-bare-kit'), { recursive: true })
  await mkdir(path.join(nodeModules, 'bare-stow'), { recursive: true })
  await writeFile(
    path.join(nodeModules, 'react-native-bare-kit', 'package.json'),
    '{"name":"react-native-bare-kit","type":"module"}\n'
  )
  await writeFile(
    path.join(nodeModules, 'react-native-bare-kit', 'index.js'),
    `export class Worklet {
  constructor(opts) {
    globalThis.__workletOpts = opts
    this.IPC = { marker: 'raw-ipc' }
  }
  start(filename, source, args) {
    globalThis.__workletStart = { filename, source, args }
  }
}
`
  )
  await writeFile(
    path.join(nodeModules, 'bare-stow', 'package.json'),
    '{"name":"bare-stow","type":"module","exports":{"./host":"./host.js"}}\n'
  )
  await writeFile(
    path.join(nodeModules, 'bare-stow', 'host.js'),
    `export default {
  wrap(ipc) {
    return {
      ready: Promise.resolve(),
      terminate() {},
      source: ipc
    }
  }
}
`
  )

  const moduleUrl = `${pathToFileURL(build.descriptor.harnessPath).href}?run=${Date.now()}`
  const harnessModule = await import(moduleUrl)
  await harnessModule.default.start({ mode: 'test' }, ['react-native-bare-kit', 'sync.js', '{"storagePath":"/tmp/sync"}'])

  const startCall = Reflect.get(globalThis, '__workletStart') as
    | { readonly args: readonly string[]; readonly filename: string }
    | undefined
  t.alike(startCall?.args, ['react-native-bare-kit', 'sync.js', '{"storagePath":"/tmp/sync"}'])
  t.is(startCall?.filename, '/core.bundle')
  const bundleSource = await readFile(build.bundlePath, 'utf8')
  const bundle = Bundle.from(JSON.parse(bundleSource.replace(/^export default /, '').replace(/;$/, '')))
  const bundleAddons = Array.isArray((bundle as unknown as { addons?: unknown }).addons)
    ? ((bundle as unknown as { addons: unknown[] }).addons.filter((item): item is string => typeof item === 'string').sort())
    : []
  t.alike(build.metadata.nativeAddons, bundleAddons)
})

test('generated sync harness bootstrap stubs exist in clean checkout', async (t) => {
  const ignoreSource = await readFile(
    new URL('../generated/react-native/.gitignore', import.meta.url),
    'utf8'
  )
  const jsSource = await readFile(new URL('../generated/react-native/sync.js', import.meta.url), 'utf8')
  const dtsSource = await readFile(
    new URL('../generated/react-native/sync.d.ts', import.meta.url),
    'utf8'
  )
  t.ok(ignoreSource.includes('*.bundle.mjs'))
  t.ok(ignoreSource.includes('*.metadata.json'))
  t.is(ignoreSource.includes('*.js'), false)
  t.is(ignoreSource.includes('*.d.ts'), false)
  t.ok(jsSource.includes('Missing @qvac/sync react-native generated harness'))
  t.ok(dtsSource.includes('args?: readonly string[]'))
})
