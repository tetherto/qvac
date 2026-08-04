import { describe, expect, it } from 'vitest'
import { readFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import {
  duplexPair,
  type HarnessRuntime
} from '@qvac/harness'
import type { SyncRuntime } from '@qvac/sync'
import { createAssistant } from '../index.ts'
import {
  createReactNativeAssistantComponents
} from '../lib/react-native-adapters.ts'

describe('react-native assistant adapters', () => {
  it('starts sync and harness via package-owned launchers', async () => {
    const syncLaunches: Array<{ storagePath: string }> = []
    const harnessLaunches: Array<{ id: string; args: readonly string[] }> = []
    const [assistantHarnessChannel] = duplexPair()
    const [assistantSdkChannel] = duplexPair()
    const closeOrder: string[] = []
    let describeCalls = 0
    const remoteHarness: HarnessRuntime & {
      describeRuntime(): Promise<{
        component: string
        runtime: string
        instanceId: string
        processId: number
        contract: string
        protocolVersion: number
        capabilities: readonly string[]
        buildVersion: string
      }>
    } = {
      async *run(input) {
        yield { type: 'content', text: 'hello from sdk' }
        if (input.model === 'error') throw new Error('remote run failed')
      },
      async describeRuntime() {
        describeCalls++
        const sdkIdentity =
          describeCalls < 2
            ? undefined
            : {
                component: 'sdk',
                runtime: 'bun',
                instanceId: 'sdk-mobile-test',
                processId: 15,
                buildVersion: '0.0.0-poc'
              }
        return {
          component: 'harness',
          runtime: 'bare',
          instanceId: 'harness-mobile-test',
          processId: 11,
          contract: 'qvac.harness',
          protocolVersion: 1,
          capabilities: ['execution.run', 'state.sync'],
          buildVersion: '0.0.0-poc',
          ...(sdkIdentity ? { sdkIdentity } : {})
        }
      },
      async close() {
        closeOrder.push('harness-hrpc')
      }
    }

    const components = createReactNativeAssistantComponents(
      {
        storagePath: '/tmp/rn-assistant',
        inference: { kind: 'qwen' },
        logging: { level: 'debug' }
      },
      {
        createSyncRuntime(options) {
          syncLaunches.push({ storagePath: options.storagePath })
          return createFakeSyncRuntime()
        },
        harnessLauncher: {
          async start(id, _options, args = []) {
            harnessLaunches.push({ id, args })
            return {
              ipc: assistantHarnessChannel,
              sdkIpc: assistantSdkChannel,
              worklet: {
                async terminate() {
                  closeOrder.push('worklet')
                }
              }
            }
          }
        },
        connectHarnessRuntime: () => remoteHarness as never,
        async createSdkBridge() {
          return {
            sdk: {
              async loadModel() {
                return 'unused'
              },
              completion() {
                return {
                  requestId: 'unused',
                  events: (async function* () {
                    yield { type: 'completionDone' as const, stopReason: 'eos' }
                  })()
                }
              },
              async cancel() {},
              async heartbeat() {
                return { ok: true }
              },
              async close() {
                closeOrder.push('sdk-client')
              }
            },
            async close() {
              closeOrder.push('sdk-bridge')
            }
          }
        }
      }
    )
    const assistant = createAssistant({
      components
    })
    await assistant.ready()
    expect(syncLaunches).toEqual([{ storagePath: '/tmp/rn-assistant' }])
    expect(harnessLaunches[0]?.id).toBe('Harness')

    const events = []
    for await (const event of assistant.run({
      runId: 'run-mobile-1',
      traceId: 'trace-mobile-1',
      model: 'registry://model.gguf',
      messages: [{ role: 'user', content: 'hello' }]
    })) {
      events.push(event)
    }
    expect(events).toEqual([{ type: 'content', text: 'hello from sdk' }])
    expect(await assistant.readRun('run-mobile-1')).toEqual(events)
    expect(assistant.inspect().sdkStarts).toBe(1)
    expect(assistant.inspect().children[1]?.details?.sdkIdentity).toMatchObject({
      component: 'sdk',
      instanceId: 'sdk-mobile-test'
    })

    await expect(
      collect(
        assistant.run({
          runId: 'run-mobile-error',
          traceId: 'trace-mobile-error',
          model: 'error',
          messages: [{ role: 'user', content: 'fail' }]
        })
      )
    ).rejects.toThrow('remote run failed')
    expect(await assistant.readRun('run-mobile-error')).toEqual([
      { type: 'content', text: 'hello from sdk' }
    ])

    for await (const _event of assistant.run({
      runId: 'run-mobile-abort',
      traceId: 'trace-mobile-abort',
      model: 'registry://model.gguf',
      messages: [{ role: 'user', content: 'stop' }]
    })) {
      break
    }
    expect(await assistant.readRun('run-mobile-abort')).toEqual([
      { type: 'content', text: 'hello from sdk' }
    ])

    const pendingRun = assistant
      .run({
        runId: 'run-mobile-close',
        traceId: 'trace-mobile-close',
        model: 'registry://model.gguf',
        messages: [{ role: 'user', content: 'close' }]
      })
      [Symbol.asyncIterator]()
    await pendingRun.next()
    await assistant.close()
    await assistant.close()
    expect(closeOrder).toEqual(['harness-hrpc', 'sdk-bridge', 'worklet'])
  })

  it('fails closed on sync and harness handshake mismatches', async () => {
    const okSyncCapabilities = [
      'profile-protocol',
      'durable-work',
      'passive-replication',
      'writer-pairing'
    ] as const
    const okHarnessCapabilities = ['execution.run', 'state.sync'] as const

    const makeSync = (contract: string, protocolVersion: number, capabilities: readonly string[]) => {
      return {
        state: createFakeSyncRuntime(),
        handshake: {
          contract,
          protocolVersion,
          capabilities,
          requiredPeerCapabilities: [],
          buildVersion: '0.0.0-poc'
        },
        close: async () => {}
      }
    }

    const assistantSyncMismatch = createAssistant({
      components: {
        startSync: async () =>
          makeSync('qvac.sync.wrong', 1, okSyncCapabilities) as never,
        startHarness: async () => ({
          harness: { run: async function* () {}, close: async () => {} },
          readRun: async () => [],
          handshake: {
            contract: 'qvac.harness',
            protocolVersion: 1,
            capabilities: okHarnessCapabilities,
            requiredPeerCapabilities: [],
            buildVersion: '0.0.0-poc'
          },
          close: async () => {}
        })
      }
    })
    await expect(assistantSyncMismatch.ready()).rejects.toThrow(
      'sync handshake failed: contract mismatch'
    )

    const assistantHarnessMismatch = createAssistant({
      components: {
        startSync: async () =>
          makeSync('qvac.sync', 1, okSyncCapabilities) as never,
        startHarness: async () => ({
          harness: { run: async function* () {}, close: async () => {} },
          readRun: async () => [],
          handshake: {
            contract: 'qvac.harness',
            protocolVersion: 1,
            capabilities: ['execution.run'],
            requiredPeerCapabilities: [],
            buildVersion: '0.0.0-poc'
          },
          close: async () => {}
        })
      }
    })
    await expect(assistantHarnessMismatch.ready()).rejects.toThrow(
      'harness handshake failed: required capabilities missing'
    )
  })

  it('marks mobile components exited on unexpected disconnect', async () => {
    let syncDisconnect: (() => void) | null = null
    const components = createReactNativeAssistantComponents(
      {
        storagePath: '/tmp/rn-assistant-disconnect'
      },
      {
        createSyncRuntime() {
          return createFakeSyncRuntime({
            onExit(exit) {
              syncDisconnect = exit
            }
          })
        },
        harnessLauncher: {
          async start() {
            throw new Error('unused')
          }
        },
        async createSdkBridge() {
          throw new Error('unused')
        }
      }
    )

    const syncComponent = await components.startSync()
    const triggerDisconnect = syncDisconnect as (() => void) | null
    triggerDisconnect?.()
    await expect(syncComponent.exited).resolves.toEqual({
      kind: 'crashed',
      code: null,
      signal: null
    })
  })

  it('package exports include react-native default selection', async () => {
    const packageJson = JSON.parse(
      await readFile(new URL('../package.json', import.meta.url), 'utf8')
    ) as { exports: Record<string, unknown> }
    const exportsMap = packageJson.exports
    expect(exportsMap['./react-native']).toBe('./react-native.ts')
    expect(exportsMap['.']).toMatchObject({
      'react-native': './react-native.ts',
      default: './index.ts'
    })
  })

  it('keeps the react-native entry graph Metro-safe', async () => {
    const packagesRoot = resolve(
      dirname(new URL('../react-native.ts', import.meta.url).pathname),
      '..'
    )
    const packageCache = new Map<string, { root: string; exports: Record<string, unknown> }>()
    const seen = new Set<string>()
    const seenSpecifiers = new Set<string>()
    const queue = ['@qvac/assistant/react-native']
    while (queue.length > 0) {
      const specifier = queue.shift()
      if (!specifier) continue
      const path = await resolveWorkspaceSpecifier(specifier, packagesRoot, packageCache)
      if (!path) continue
      if (seen.has(path)) continue
      seen.add(path)
      const source = await readFile(path, 'utf8')
      expect(source.includes("from 'node:"), path).toBe(false)
      const imports = [
        ...source.matchAll(/from ['"]([^'"]+)['"]/g),
        ...source.matchAll(/import\(['"]([^'"]+)['"]\)/g)
      ]
      for (const match of imports) {
        const nextSpecifier = match[1]
        if (!nextSpecifier) continue
        seenSpecifiers.add(nextSpecifier)
        if (nextSpecifier.startsWith('.')) {
          queue.push(resolveRelativeSpecifier(path, nextSpecifier))
          continue
        }
        if (nextSpecifier.startsWith('@qvac/')) {
          queue.push(nextSpecifier)
        }
      }
    }
    expect(seenSpecifiers.has('@qvac/harness')).toBe(false)
    expect(seenSpecifiers.has('@qvac/assistant')).toBe(false)
  })

  it('awaits teardown when sync startup fails', async () => {
    let closeCalled = false
    let terminateFinished = false
    const components = createReactNativeAssistantComponents(
      {
        storagePath: '/tmp/rn-assistant-startup-fail'
      },
      {
        createSyncRuntime() {
          return createFakeSyncRuntime({
            describe: async () => {
              throw new Error('describe failed')
            },
            async close() {
              closeCalled = true
              await new Promise((resolve) => setTimeout(resolve, 5))
              terminateFinished = true
            }
          })
        },
        harnessLauncher: {
          async start() {
            throw new Error('unused')
          }
        },
        async createSdkBridge() {
          throw new Error('unused')
        }
      }
    )
    await expect(components.startSync()).rejects.toThrow('describe failed')
    expect(closeCalled).toBe(true)
    expect(terminateFinished).toBe(true)
  })

  it('fails fast for unsupported mobile inference options', async () => {
    const components = createReactNativeAssistantComponents({
      storagePath: '/tmp/rn-assistant-inference',
      inference: { kind: 'deterministic' }
    })
    await expect(
      components.startHarness({
        state: createFakeSyncRuntime()
      })
    ).rejects.toThrow('unsupported mobile inference')
  })

  it('cleans up launched Harness when startup fails', async () => {
    let terminateCalled = false
    let bridgeClosed = false
    const components = createReactNativeAssistantComponents(
      {
        storagePath: '/tmp/rn-assistant-harness-startup-fail'
      },
      {
        createSyncRuntime() {
          throw new Error('unused')
        },
        harnessLauncher: {
          async start() {
            const [sdkIpc] = duplexPair()
            return {
              ipc: {
                on() {
                  return this
                },
                removeListener() {
                  return this
                },
                destroy() {}
              },
              sdkIpc,
              worklet: {
                async terminate() {
                  terminateCalled = true
                }
              }
            }
          }
        },
        async createSdkBridge() {
          bridgeClosed = true
          throw new Error('bridge startup failed')
        }
      }
    )
    await expect(
      components.startHarness({
        state: createFakeSyncRuntime()
      })
    ).rejects.toThrow('bridge startup failed')
    expect(bridgeClosed).toBe(true)
    expect(terminateCalled).toBe(true)
  })

  it('continues cleanup when one close step rejects', async () => {
    const calls: string[] = []
    const components = createReactNativeAssistantComponents(
      {
        storagePath: '/tmp/rn-assistant-close-reject'
      },
      {
        createSyncRuntime() {
          throw new Error('unused')
        },
        harnessLauncher: {
          async start() {
            const [sdkIpc] = duplexPair()
            return {
              ipc: {
                on() {
                  return this
                },
                removeListener() {
                  return this
                },
                destroy() {}
              },
              sdkIpc,
              worklet: {
                async terminate() {
                  calls.push('terminate')
                }
              }
            }
          }
        },
        connectHarnessRuntime: () => ({
          async describeRuntime() {
            return {
              component: 'harness',
              runtime: 'bare',
              instanceId: 'harness-mobile',
              processId: 12,
              contract: 'qvac.harness',
              protocolVersion: 1,
              capabilities: ['execution.run', 'state.sync'],
              buildVersion: '0.0.0-poc'
            }
          },
          run: async function* () {},
          async close() {
            calls.push('remote-close')
            throw new Error('remote close failed')
          },
          lives: 1
        }) as never,
        async createSdkBridge() {
          return {
            async close() {
              calls.push('bridge-close')
            }
          }
        }
      }
    )
    const started = await components.startHarness({
      state: createFakeSyncRuntime()
    })
    await expect(started.close()).rejects.toThrow('remote close failed')
    expect(calls).toEqual(['remote-close', 'bridge-close', 'terminate'])
  })
})

function createFakeSyncRuntime(
  options: {
    readonly describe?: SyncRuntime['runtime']['describe']
    readonly close?: () => Promise<void>
    readonly onExit?: (exit: () => void) => void
  } = {}
): SyncRuntime {
  const works = new Map<string, { entries: unknown[] }>()
  let resolveExit!: (exit: {
    kind: 'closed' | 'crashed'
    code: number | null
    signal: string | null
  }) => void
  const exited = new Promise<{
    kind: 'closed' | 'crashed'
    code: number | null
    signal: string | null
  }>((resolve) => {
    resolveExit = resolve
  })
  options.onExit?.(() => {
    resolveExit({ kind: 'crashed', code: null, signal: null })
  })

  const lifecycle = {
    async suspend() {},
    async resume() {}
  }
  return {
    exited,
    async ready() {},
    ...lifecycle,
    async close() {
      await options.close?.()
      resolveExit({ kind: 'closed', code: null, signal: null })
    },
    lifecycle,
    runtime: {
      describe:
        options.describe ??
        (async () => ({
          component: 'sync',
          runtime: 'bare',
          instanceId: 'sync-mobile-test',
          processId: 9,
          contract: 'qvac.sync',
          protocolVersion: 1,
          capabilities: [
            'profile-protocol',
            'durable-work',
            'passive-replication',
            'writer-pairing',
            'dynamic-membership',
            'runtime-lifecycle',
            'device-management'
          ],
          buildVersion: '0.0.0-poc'
        })),
      async status() {
        return { phase: 'ready', generation: 1, networkState: 'joined' } as never
      },
      async diagnostics() {
        return { children: [] } as never
      }
    },
    mesh: {
      async identity() {
        return { deviceId: Buffer.from('id') } as never
      },
      async status() {
        return { state: 'joined' } as never
      },
      watchStatus: async function* () {},
      async createInvite() {
        return {
          id: Buffer.alloc(16),
          invite: Buffer.from('invite'),
          expiresAt: Date.now() + 60_000
        }
      },
      watchPairingRequests: async function* () {},
      async approvePairingRequest() {
        return {} as never
      },
      async rejectPairingRequest() {
        return {} as never
      },
      async join() {},
      async cancelJoin() {},
      async leave() {},
      async listDevices() {
        return []
      },
      watchDevices: async function* () {},
      async renameDevice() {
        return {} as never
      },
      async removeDevice() {}
    },
    openProfile() {
      return {
        async apply(command: unknown) {
          const value = command as {
            type: string
            workId: string
            entryType?: string
            body?: unknown
          }
          if (value.type === 'record-work') {
            works.set(value.workId, { entries: [] })
          } else if (value.type === 'append-journal') {
            const work = works.get(value.workId) ?? { entries: [] }
            work.entries.push({
              entryType: value.entryType,
              body: value.body
            })
            works.set(value.workId, work)
          }
          return {} as never
        },
        async query(query: unknown) {
          const value = query as { type: string; workId: string }
          const work = works.get(value.workId)
          if (value.type === 'get-work') {
            return { work: work ? { workId: value.workId } : null } as never
          }
          return { entries: work?.entries ?? [] } as never
        },
        watch: async function* () {}
      }
    }
  } as unknown as SyncRuntime
}

async function collect<T>(events: AsyncIterable<T>) {
  const collected: T[] = []
  for await (const event of events) {
    collected.push(event)
  }
  return collected
}

function resolveRelativeSpecifier(path: string, specifier: string) {
  const nextPath = resolve(dirname(path), specifier)
  if (/\.[a-z0-9]+$/i.test(nextPath)) return nextPath
  return `${nextPath}.ts`
}

async function resolveWorkspaceSpecifier(
  specifier: string,
  workspaceRoot: string,
  packageCache: Map<string, { root: string; exports: Record<string, unknown> }>
): Promise<string | null> {
  if (specifier.startsWith('/')) return specifier
  if (specifier.endsWith('.ts')) return specifier
  if (!specifier.startsWith('@qvac/')) return specifier
  const [scope, name, ...subpathParts] = specifier.split('/')
  if (!scope || !name) return null
  const packageName = `${scope}/${name}`
  let entry = packageCache.get(packageName)
  if (!entry) {
    const packageRoot = resolve(workspaceRoot, name)
    let packageJsonSource: string
    try {
      packageJsonSource = await readFile(resolve(packageRoot, 'package.json'), 'utf8')
    } catch {
      return null
    }
    const packageJson = JSON.parse(packageJsonSource) as {
      exports: Record<string, unknown>
    }
    entry = { root: packageRoot, exports: packageJson.exports }
    packageCache.set(packageName, entry)
  }
  const subpath = subpathParts.length === 0 ? '.' : `./${subpathParts.join('/')}`
  const target = entry.exports[subpath]
  if (typeof target === 'string') return resolve(entry.root, target)
  if (typeof target === 'object' && target !== null) {
    const reactNative = Reflect.get(target, 'react-native')
    if (typeof reactNative === 'string') return resolve(entry.root, reactNative)
    const defaultTarget = Reflect.get(target, 'default')
    if (typeof defaultTarget === 'string') return resolve(entry.root, defaultTarget)
  }
  throw new Error(`Cannot resolve workspace specifier: ${specifier}`)
}
