import test from 'brittle'
import { mkdtemp, readFile } from 'fs/promises'
import os from 'os'
import path from 'path'
import stow from 'bare-stow'
import Bundle from 'bare-bundle'
import reactNativeTarget from 'bare-stow-target-react-native'
import { fileURLToPath, pathToFileURL } from 'url'
import {
  buildHarnessReactNativeBundle,
  createHarnessReactNativeDescriptor,
  harnessReactNativeHosts
} from '../lib/react-native-stow.ts'
import { createMobileHarnessEntry } from '../mobile-entry.ts'
import { createBinaryChannelMultiplexer } from '../lib/mobile-multiplex.ts'
import { createHarnessReactNativeLauncher } from '../lib/react-native-launcher.ts'
import { createWorkerSdkRuntimePort } from '../lib/mobile-sdk-transport.ts'
import { createHostSdkTransportServer } from '../lib/mobile-sdk-transport.ts'
import { duplexPair } from '../lib/transport.ts'
import {
  configArgvForHarness,
  resolveHarnessConfig
} from '../lib/config.ts'

const mobileConfigArgv = configArgvForHarness(
  resolveHarnessConfig(undefined, {})
)

test('harness react-native descriptor uses package-owned generated paths', async (t) => {
  const descriptor = createHarnessReactNativeDescriptor()
  t.ok(
    descriptor.entryPath.endsWith('/packages/harness/mobile-entry.ts'),
    'entry points to the package-owned mobile worker'
  )
  t.ok(
    descriptor.harnessPath.endsWith('/packages/harness/generated/react-native/harness.js'),
    'harness path is stable and package-owned'
  )
  t.ok(
    descriptor.metadataPath.endsWith(
      '/packages/harness/generated/react-native/harness.metadata.json'
    ),
    'metadata path is stable and package-owned'
  )
  t.is(descriptor.contract, 'qvac.harness')
  t.is(descriptor.protocolVersion, 1)
  t.alike(descriptor.hosts, harnessReactNativeHosts)
})

test('harness descriptor tracks required dependencies', async (t) => {
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

test('mobile harness entry wires host-backed SDK transport', async (t) => {
  const calls: string[] = []
  const harnessChannel = { label: 'harness', on() { return this } }
  const sdkChannel = { label: 'sdk', on() { return this } }
  const fakePort = { close: async () => {} }
  const entry = createMobileHarnessEntry({
    readArgv: () => mobileConfigArgv,
    createStream(ipc) {
      calls.push('stream')
      return ipc as never
    },
    createMultiplexer() {
      return {
        openChannel(channelId: number) {
          return (channelId === 1 ? harnessChannel : sdkChannel) as never
        },
        close() {}
      } as never
    },
    createWorkerSdkPort(stream) {
      t.is(stream, sdkChannel as never)
      calls.push('sdk')
      return fakePort as never
    },
    createChild(childOptions) {
      calls.push('child')
      return async function startChild(stream) {
        t.is(stream, harnessChannel as never)
        const sdk = await childOptions.createSdk()
        t.is(sdk, fakePort as never)
        calls.push('started')
        return async () => {}
      }
    }
  })
  await entry({} as never)
  t.alike(calls, ['stream', 'child', 'sdk', 'started'])
})

test('mobile harness entry separates harness and sdk channels', async (t) => {
  const channelLabels: string[] = []
  const harnessChannel = { label: 'harness', on() { return this } }
  const sdkChannel = { label: 'sdk', on() { return this } }
  const entry = createMobileHarnessEntry({
    readArgv: () => mobileConfigArgv,
    createMultiplexer(stream) {
      return {
        openChannel(channelId: number) {
          const label = channelId === 1 ? 'harness' : 'sdk'
          channelLabels.push(`${label}-open`)
          return (channelId === 1 ? harnessChannel : sdkChannel) as never
        },
        close() {}
      } as never
    },
    createWorkerSdkPort(stream) {
      channelLabels.push(`sdk-port:${(stream as unknown as { label: string }).label}`)
      return { close: async () => {} } as never
    },
    createChild(childOptions) {
      return async function startChild(stream) {
        channelLabels.push(`child:${(stream as unknown as { label: string }).label}`)
        await childOptions.createSdk()
        return async () => {}
      }
    }
  })
  await entry({} as never)
  t.alike(channelLabels, ['harness-open', 'sdk-open', 'child:harness', 'sdk-port:sdk'])
})

test('binary multiplexer keeps logical channels isolated', async (t) => {
  const writes: Uint8Array[] = []
  const listeners = new Map<string, Array<(value: Uint8Array) => void>>()
  const transport = {
    on(event: 'data', listener: (data: Uint8Array) => void) {
      const registered = listeners.get(event) ?? []
      registered.push(listener)
      listeners.set(event, registered)
      return this
    },
    removeListener() {
      return this
    },
    write(data: Uint8Array) {
      writes.push(data)
      return true
    },
    destroy() {}
  }
  const mux = createBinaryChannelMultiplexer(transport as never)
  const harness = mux.openChannel(1)
  const sdk = mux.openChannel(2)
  harness.resume?.()
  sdk.resume?.()
  harness.write(new TextEncoder().encode('h-1'))
  sdk.write(new TextEncoder().encode('s-1'))
  await new Promise((resolve) => setTimeout(resolve, 0))
  t.is(writes[0]?.[0], 1)
  t.is(writes[1]?.[0], 2)
  t.is(new TextDecoder().decode(writes[0]?.slice(5) ?? new Uint8Array()), 'h-1')
  t.is(new TextDecoder().decode(writes[1]?.slice(5) ?? new Uint8Array()), 's-1')

  for (const frame of writes) {
    for (const listener of listeners.get('data') ?? []) {
      listener(frame)
    }
  }

  const listenersInbound = new Map<string, Array<(value: Uint8Array) => void>>()
  const transportInbound = {
    on(event: 'data', listener: (data: Uint8Array) => void) {
      const registered = listenersInbound.get(event) ?? []
      registered.push(listener)
      listenersInbound.set(event, registered)
      return this
    },
    removeListener() {
      return this
    },
    write() {
      return true
    },
    destroy() {}
  }
  const inboundMux = createBinaryChannelMultiplexer(transportInbound as never)
  const inboundHarness = inboundMux.openChannel(1)
  const inboundSdk = inboundMux.openChannel(2)
  const harnessReads: Uint8Array[] = []
  const sdkReads: Uint8Array[] = []
  inboundHarness.on('data', (chunk: unknown) => {
    if (chunk instanceof Uint8Array) harnessReads.push(chunk)
  })
  inboundSdk.on('data', (chunk: unknown) => {
    if (chunk instanceof Uint8Array) sdkReads.push(chunk)
  })
  inboundHarness.resume?.()
  inboundSdk.resume?.()
  const inboundFrame = new Uint8Array([
    2,
    0,
    0,
    0,
    5,
    ...new TextEncoder().encode('in-s2')
  ])
  for (const listener of listenersInbound.get('data') ?? []) {
    listener(inboundFrame)
  }
  await new Promise((resolve) => setTimeout(resolve, 0))
  t.is(harnessReads.length, 0)
  t.is(new TextDecoder().decode(sdkReads[0] ?? new Uint8Array()), 'in-s2')
})

test('binary multiplexer reassembles fragmented BareKit IPC frames', async (t) => {
  const listeners = new Map<string, Array<(value: Uint8Array) => void>>()
  const carrier = {
    on(event: 'data', listener: (data: Uint8Array) => void) {
      const registered = listeners.get(event) ?? []
      registered.push(listener)
      listeners.set(event, registered)
      return this
    },
    write() {
      return true
    },
    destroy() {}
  }
  const mux = createBinaryChannelMultiplexer(carrier as never)
  const channel = mux.openChannel(1)
  const received: Uint8Array[] = []
  channel.on('data', (chunk: unknown) => {
    if (chunk instanceof Uint8Array) received.push(chunk)
  })
  channel.resume?.()
  const payload = new TextEncoder().encode('fragmented')
  const frame = new Uint8Array([1, 0, 0, 0, payload.byteLength, ...payload])
  const onData = listeners.get('data') ?? []

  for (const chunk of [frame.slice(0, 2), frame.slice(2, 7), frame.slice(7)]) {
    for (const listener of onData) listener(chunk)
  }
  await new Promise((resolve) => setTimeout(resolve, 0))

  // Compare bytes, not the concrete view: frames are handed on as a Buffer
  // where one exists so downstream codecs can call toString(encoding, ...).
  t.alike(
    received.map((chunk) => [...chunk]),
    [[...payload]]
  )
})

test('harness build patches generated launcher for argv', async (t) => {
  const output = await buildHarnessReactNativeBundle({
    outputDirectory: await mkdtemp(path.join(os.tmpdir(), 'harness-rn-stow-'))
  })
  const harnessSource = await readFile(output.descriptor.harnessPath, 'utf8')
  const bundleSource = await readFile(output.bundlePath, 'utf8')
  const declarationSource = await readFile(
    output.descriptor.harnessPath.replace(/\.js$/, '.d.ts'),
    'utf8'
  )
  const bundle = Bundle.from(JSON.parse(bundleSource.replace(/^export default /, '').replace(/;$/, '')))
  const bundleAddons = Array.isArray((bundle as unknown as { addons?: unknown }).addons)
    ? ((bundle as unknown as { addons: unknown[] }).addons.filter((item): item is string => typeof item === 'string').sort())
    : []
  t.ok(harnessSource.includes('args = []'))
  // Bytes, not the bundle string: BareKit sizes its copy from the value it is
  // given, and a string makes that size disagree with the bytes written.
  t.ok(
    harnessSource.includes(
      "worklet.start('/core.bundle', new TextEncoder().encode(bundle), args)"
    )
  )
  t.ok(declarationSource.includes('args?: readonly string[]'))
  t.alike(output.metadata.nativeAddons, bundleAddons)
})

test('harness launcher exposes separate harness and sdk channels', async (t) => {
  const writes: Uint8Array[] = []
  const listeners = new Map<string, Array<(value: Uint8Array) => void>>()
  const launcher = createHarnessReactNativeLauncher({
    async start() {
      return {
        ipc: {
          terminate() {},
          on(event: 'data' | 'close' | 'error', listener: (...args: unknown[]) => void) {
            const cast = listener as (value: Uint8Array) => void
            const existing = listeners.get(event) ?? []
            existing.push(cast)
            listeners.set(event, existing)
            return this
          },
          write(chunk: Uint8Array) {
            writes.push(chunk)
            return true
          },
          destroy() {}
        }
      }
    }
  })
  const started = await launcher.start('Harness', {}, [])
  started.ipc.resume?.()
  started.sdkIpc.resume?.()
  started.ipc.write(new TextEncoder().encode('h'))
  started.sdkIpc.write(new TextEncoder().encode('s'))
  await new Promise((resolve) => setTimeout(resolve, 0))
  t.is(writes[0]?.[0], 1)
  t.is(writes[1]?.[0], 2)
  t.is(new TextDecoder().decode(writes[0]?.slice(5) ?? new Uint8Array()), 'h')
  t.is(new TextDecoder().decode(writes[1]?.slice(5) ?? new Uint8Array()), 's')
  for (const frame of writes) {
    for (const listener of listeners.get('data') ?? []) {
      listener(frame)
    }
  }
})

test('pending sdk request rejects when carrier closes', async (t) => {
  const listeners = new Map<string, Array<(...args: unknown[]) => void>>()
  const carrier = {
    on(event: 'data' | 'close' | 'error', listener: (...args: unknown[]) => void) {
      const existing = listeners.get(event) ?? []
      existing.push(listener)
      listeners.set(event, existing)
      return this
    },
    removeListener() {
      return this
    },
    write() {
      return true
    },
    destroy() {
      for (const listener of listeners.get('close') ?? []) listener()
    }
  }
  const mux = createBinaryChannelMultiplexer(carrier as never)
  const sdkPort = createWorkerSdkRuntimePort(mux.openChannel(2))
  const pending = sdkPort.loadModel({
    model: 'qwen',
    traceId: 'trace-close'
  })
  for (const listener of listeners.get('close') ?? []) listener()
  await expectReject(pending)
})

test('pending sdk request rejects when carrier errors', async (t) => {
  const listeners = new Map<string, Array<(...args: unknown[]) => void>>()
  const carrier = {
    on(event: 'data' | 'close' | 'error', listener: (...args: unknown[]) => void) {
      const existing = listeners.get(event) ?? []
      existing.push(listener)
      listeners.set(event, existing)
      return this
    },
    removeListener() {
      return this
    },
    write() {
      return true
    },
    destroy() {}
  }
  const mux = createBinaryChannelMultiplexer(carrier as never)
  const sdkPort = createWorkerSdkRuntimePort(mux.openChannel(2))
  const pending = sdkPort.heartbeat()
  for (const listener of listeners.get('error') ?? []) listener(new Error('boom'))
  await expectReject(pending)
})

test('sdk transport preserves unicode without web text codecs', async (t) => {
  const [host, worker] = duplexPair()
  let receivedModel = ''
  const server = createHostSdkTransportServer(host, {
    async loadModel({ modelSrc }) {
      receivedModel = modelSrc
      return `loaded:${modelSrc}`
    },
    completion() {
      throw new Error('completion is not used')
    },
    async cancel() {},
    async heartbeat() {
      return { ok: true }
    },
    async close() {}
  })
  const runtime = createWorkerSdkRuntimePort(worker)

  const loaded = await runtime.loadModel({
    model: '模型🙂',
    traceId: 'trace-unicode'
  })

  t.is(receivedModel, '模型🙂')
  t.is(loaded.modelId, 'loaded:模型🙂')
  await runtime.close()
  await server.close()
})

test('host transport cancels active public requests on disconnect', async (t) => {
  const [host, worker] = duplexPair()
  const cancelled: string[] = []
  let completionStarted = false
  const server = createHostSdkTransportServer(host, {
    async loadModel({ modelSrc }) {
      return `loaded:${modelSrc}`
    },
    completion() {
      completionStarted = true
      return {
        requestId: 'host-request-77',
        events: (async function* () {
          await new Promise((resolve) => setTimeout(resolve, 50))
          yield { type: 'contentDelta' as const, text: 'late' }
        })()
      }
    },
    async cancel({ requestId }) {
      cancelled.push(requestId)
    },
    async heartbeat() {
      return { ok: true }
    },
    async close() {}
  })
  const runtime = createWorkerSdkRuntimePort(worker)
  const run = runtime.completion({
    requestId: 'local-run-disconnect',
    traceId: 'trace-disconnect',
    modelId: 'loaded:model',
    messages: [{ role: 'user', content: 'hello' }],
    signal: new AbortController().signal
  })
  const iterator = run.events[Symbol.asyncIterator]()
  const pendingRead = iterator.next()
  await waitFor(() => completionStarted)
  host.destroy()
  await pendingRead
  await new Promise((resolve) => setTimeout(resolve, 20))
  t.alike(cancelled, ['host-request-77'])
  await server.close()
})

test('host transport contains async response errors after disconnect', async (t) => {
  const listeners = new Map<string, Array<(...args: unknown[]) => void>>()
  let disconnected = false
  const stream = {
    on(event: 'data' | 'close' | 'error', listener: (...args: unknown[]) => void) {
      const existing = listeners.get(event) ?? []
      existing.push(listener)
      listeners.set(event, existing)
      return this
    },
    write() {
      if (disconnected) throw new Error('transport disconnected')
      return true
    },
    destroy() {
      disconnected = true
      for (const listener of listeners.get('close') ?? []) listener()
    }
  }
  createHostSdkTransportServer(stream as never, {
    async loadModel() {
      return 'loaded:model'
    },
    completion() {
      return {
        requestId: 'req-1',
        events: (async function* () {
          yield { type: 'completionDone' as const, stopReason: 'eos' }
        })()
      }
    },
    async cancel() {},
    async heartbeat() {
      return { ok: true }
    },
    async close() {}
  })
  stream.destroy()
  const requestFrame = new TextEncoder().encode(
    `${JSON.stringify({ kind: 'request', id: 1, method: 'heartbeat', payload: null })}\n`
  )
  for (const listener of listeners.get('data') ?? []) listener(requestFrame)
  await new Promise((resolve) => setTimeout(resolve, 0))
  t.ok(true, 'dispatch rejections are contained after disconnect')
})

test('carrier close is graceful for harness channel', async (t) => {
  const listeners = new Map<string, Array<(...args: unknown[]) => void>>()
  const carrier = {
    on(event: 'data' | 'close' | 'error', listener: (...args: unknown[]) => void) {
      const existing = listeners.get(event) ?? []
      existing.push(listener)
      listeners.set(event, existing)
      return this
    },
    write() {
      return true
    },
    destroy() {}
  }
  const mux = createBinaryChannelMultiplexer(carrier as never)
  const harness = mux.openChannel(1)
  let harnessErrors = 0
  harness.on('error', () => {
    harnessErrors += 1
  })
  harness.resume?.()
  for (const listener of listeners.get('close') ?? []) listener()
  await new Promise((resolve) => setTimeout(resolve, 0))
  t.is(harnessErrors, 0)
})

test('unknown logical channel frames do not throw', async (t) => {
  const listeners = new Map<string, Array<(...args: unknown[]) => void>>()
  const carrier = {
    on(event: 'data' | 'close' | 'error', listener: (...args: unknown[]) => void) {
      const existing = listeners.get(event) ?? []
      existing.push(listener)
      listeners.set(event, existing)
      return this
    },
    write() {
      return true
    },
    destroy() {}
  }
  createBinaryChannelMultiplexer(carrier as never)
  const inboundFrame = new Uint8Array([
    7,
    0,
    0,
    0,
    3,
    ...new TextEncoder().encode('abc')
  ])
  for (const listener of listeners.get('data') ?? []) {
    listener(inboundFrame)
  }
  t.ok(true, 'unknown channel frame handled safely')
})

test('harness cleanup runs after carrier close', async (t) => {
  const listeners = new Map<string, Array<(...args: unknown[]) => void>>()
  const entry = createMobileHarnessEntry({
    readArgv: () => mobileConfigArgv,
    createStream() {
      return {
        on(event: 'data' | 'close' | 'error', listener: (...args: unknown[]) => void) {
          const existing = listeners.get(event) ?? []
          existing.push(listener)
          listeners.set(event, existing)
          return this
        },
        write() {
          return true
        },
        destroy() {}
      } as never
    },
    createWorkerSdkPort() {
      return { close: async () => {} } as never
    },
    createChild() {
      return async function startChild() {
        return async function stop() {
          cleanupRuns += 1
        }
      }
    }
  })
  let cleanupRuns = 0
  const stop = await entry({} as never)
  for (const listener of listeners.get('close') ?? []) listener()
  await stop()
  t.is(cleanupRuns, 1)
})

// The argv and sidecar wiring moved into the shared entry factory so that
// application-authored entries cannot drift from it.
test('desktop child entry still requires sdk sidecar argv', async (t) => {
  const source = await readFile(
    new URL('../lib/skills/host-entry.ts', import.meta.url),
    'utf8'
  )
  t.ok(source.includes('--sdk-entry='), 'desktop entry still reads --sdk-entry argument')
  t.ok(
    source.includes('createSdkSidecarAdapter'),
    'desktop entry still uses sidecar adapter path'
  )
})

test('stowing desktop child entry keeps explicit #bare blocker', async (t) => {
  const outputDirectory = await mkdtemp(path.join(os.tmpdir(), 'harness-child-blocker-'))
  const childEntryPath = fileURLToPath(new URL('../child-entry.ts', import.meta.url))
  await expectReject(
    (async () => {
      for await (const _artifact of stow(
        pathToFileURL(childEntryPath).href,
        reactNativeTarget,
        pathToFileURL(path.join(outputDirectory, 'harness-child.js')).href
      )) {
        // consume
      }
    })(),
    /#bare/
  )
})

test('generated harness bootstrap stubs exist in clean checkout', async (t) => {
  const ignoreSource = await readFile(
    new URL('../generated/react-native/.gitignore', import.meta.url),
    'utf8'
  )
  const jsSource = await readFile(new URL('../generated/react-native/harness.js', import.meta.url), 'utf8')
  const dtsSource = await readFile(
    new URL('../generated/react-native/harness.d.ts', import.meta.url),
    'utf8'
  )
  t.ok(ignoreSource.includes('*.bundle.mjs'))
  t.ok(ignoreSource.includes('*.metadata.json'))
  t.is(ignoreSource.includes('*.js'), false)
  t.is(ignoreSource.includes('*.d.ts'), false)
  t.ok(jsSource.includes('Missing @qvac/harness react-native generated harness'))
  t.ok(dtsSource.includes('args?: readonly string[]'))
})

async function waitFor(predicate: () => boolean) {
  const deadline = Date.now() + 1_000
  while (!predicate()) {
    if (Date.now() >= deadline) {
      throw new Error('timed out waiting for condition')
    }
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

async function expectReject(promise: Promise<unknown>, pattern?: RegExp) {
  try {
    await promise
    throw new Error('expected promise rejection')
  } catch (error) {
    if (!pattern) return
    const message = error instanceof Error ? error.message : String(error)
    if (!pattern.test(message)) {
      throw new Error(`rejection "${message}" did not match ${pattern}`)
    }
  }
}
