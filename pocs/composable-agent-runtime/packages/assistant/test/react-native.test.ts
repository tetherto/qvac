import { readFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { HarnessRuntime } from '@qvac/harness/react-native'
import type { SyncRuntime } from '@qvac/sync/react-native'
import {
  createReactNativeAssistantComponents
} from '../lib/react-native-adapters.ts'
import { createAssistantFacade } from '../lib/facade.ts'

describe('react-native assistant composition', () => {
  it('starts Sync and Harness through package-owned lifecycle APIs', async () => {
    const calls: string[] = []
    const sync = fakeSyncRuntime({
      ready: async () => {
        calls.push('sync:ready')
      }
    })
    const harness = fakeHarnessRuntime({
      ready: async () => {
        calls.push('harness:ready')
      }
    })
    const components = createReactNativeAssistantComponents(
      {
        storagePath: '/app/state',
        invite: Buffer.from('invite').toString('base64url'),
        inference: { kind: 'qwen' }
      },
      {
        createSyncRuntime(options) {
          calls.push(`sync:create:${options.storagePath}`)
          return sync
        },
        createHarnessRuntime(options) {
          calls.push(`harness:create:${options?.inference}`)
          expect(options?.state).toBe(sync)
          return harness
        }
      }
    )

    const syncComponent = await components.startSync()
    const harnessComponent = await components.startHarness({
      state: syncComponent.state
    })
    expect(calls).toEqual([
      'sync:create:/app/state',
      'sync:ready',
      'harness:create:qwen',
      'harness:ready'
    ])
    await harnessComponent.close()
    await syncComponent.close()
  })

  it('fails closed on Sync and Harness handshake mismatches', async () => {
    const badSync = fakeSyncRuntime({
      identity: syncIdentity({ protocolVersion: 99 })
    })
    const syncComponents = createReactNativeAssistantComponents(
      { storagePath: '/app/state' },
      { createSyncRuntime: () => badSync }
    )
    const syncAssistant = createAssistantFacade({}, syncComponents)
    await expect(syncAssistant.ready()).rejects.toThrow('sync handshake failed')

    const goodSync = fakeSyncRuntime()
    const badHarness = fakeHarnessRuntime({
      identity: harnessIdentity({ protocolVersion: 99 })
    })
    const harnessComponents = createReactNativeAssistantComponents(
      { storagePath: '/app/state' },
      {
        createSyncRuntime: () => goodSync,
        createHarnessRuntime: () => badHarness
      }
    )
    const harnessAssistant = createAssistantFacade({}, harnessComponents)
    await expect(harnessAssistant.ready()).rejects.toThrow(
      'harness handshake failed'
    )
  })

  it('reports an unexpected package lifecycle exit to the supervisor', async () => {
    let resolveExit!: (value: {
      kind: 'crashed'
      code: number | null
      signal: string | null
    }) => void
    const exited = new Promise<{
      kind: 'crashed'
      code: number | null
      signal: string | null
    }>((resolve) => {
      resolveExit = resolve
    })
    const components = createReactNativeAssistantComponents(
      { storagePath: '/app/state' },
      {
        createSyncRuntime: () => fakeSyncRuntime(),
        createHarnessRuntime: () => fakeHarnessRuntime({ exited })
      }
    )
    const assistant = createAssistantFacade({}, components)
    const events: string[] = []
    assistant.onLifecycle(({ type, name }) => events.push(`${type}:${name}`))
    await assistant.ready()
    resolveExit({ kind: 'crashed', code: 1, signal: null })
    await waitFor(() => events.includes('child-died:harness'))
    await assistant.close()
  })

  it('rejects unsupported mobile inference before launching Harness', async () => {
    const components = createReactNativeAssistantComponents({
      storagePath: '/app/state',
      inference: { kind: 'deterministic' }
    })
    await expect(
      components.startHarness({ state: fakeSyncRuntime() })
    ).rejects.toThrow('unsupported mobile inference: deterministic')
  })

  it('closes a package runtime when startup fails', async () => {
    let syncClosed = false
    const sync = fakeSyncRuntime({
      ready: async () => {
        throw new Error('sync failed')
      },
      close: async () => {
        syncClosed = true
      }
    })
    const syncComponents = createReactNativeAssistantComponents(
      { storagePath: '/app/state' },
      { createSyncRuntime: () => sync }
    )
    await expect(syncComponents.startSync()).rejects.toThrow('sync failed')
    expect(syncClosed).toBe(true)

    let harnessClosed = false
    const harness = fakeHarnessRuntime({
      ready: async () => {
        throw new Error('harness failed')
      },
      close: async () => {
        harnessClosed = true
      }
    })
    const harnessComponents = createReactNativeAssistantComponents(
      { storagePath: '/app/state' },
      { createHarnessRuntime: () => harness }
    )
    await expect(
      harnessComponents.startHarness({ state: fakeSyncRuntime() })
    ).rejects.toThrow('harness failed')
    expect(harnessClosed).toBe(true)
  })

  it('package exports select the React Native entry', async () => {
    const packageJson = JSON.parse(
      await readFile(new URL('../package.json', import.meta.url), 'utf8')
    ) as { exports: Record<string, unknown> }
    expect(packageJson.exports['./react-native']).toBe('./react-native.ts')
    expect(packageJson.exports['.']).toEqual({
      'react-native': './react-native.ts',
      default: './index.ts'
    })
  })

  it('keeps the React Native entry graph free of Node imports', async () => {
    const packagesRoot = resolve(
      dirname(new URL('../react-native.ts', import.meta.url).pathname),
      '..'
    )
    const seen = new Set<string>()
    const queue = [resolve(packagesRoot, 'assistant/react-native.ts')]
    while (queue.length > 0) {
      const file = queue.shift()
      if (!file || seen.has(file)) continue
      seen.add(file)
      const source = await readFile(file, 'utf8')
      expect(source.includes("from 'node:"), file).toBe(false)
      for (const match of source.matchAll(/from ['"](\.[^'"]+)['"]/g)) {
        const specifier = match[1]
        if (!specifier) continue
        queue.push(resolve(dirname(file), specifier))
      }
    }
  })
})

function fakeSyncRuntime({
  identity = syncIdentity(),
  ready = async () => {},
  close = async () => {}
}: {
  readonly identity?: ReturnType<typeof syncIdentity>
  readonly ready?: () => Promise<void>
  readonly close?: () => Promise<void>
} = {}): SyncRuntime {
  return {
    ready,
    close,
    exited: new Promise(() => {}),
    lifecycle: { suspend: async () => {}, resume: async () => {} },
    runtime: {
      describe: async () => identity,
      status: async () => ({ phase: 'ready' }),
      diagnostics: async () => ({})
    },
    mesh: {}
  } as unknown as SyncRuntime
}

function fakeHarnessRuntime({
  identity = harnessIdentity(),
  ready = async () => {},
  close = async () => {},
  exited = new Promise<never>(() => {})
}: {
  readonly identity?: ReturnType<typeof harnessIdentity>
  readonly ready?: () => Promise<void>
  readonly close?: () => Promise<void>
  readonly exited?: HarnessRuntime['exited']
} = {}): HarnessRuntime {
  return {
    ready,
    close,
    exited,
    lifecycle: { suspend: async () => {}, resume: async () => {} },
    runtime: { describe: async () => identity },
    listSkills: async () => [],
    registerAgent: async () => {},
    runAgent: async function* () {},
    cancelAgentRun: async () => {},
    readRun: async () => null,
    watchWork: async function* () {}
  }
}

function syncIdentity(overrides: Record<string, unknown> = {}) {
  return {
    component: 'sync',
    runtime: 'bare',
    instanceId: 'sync-mobile-test',
    processId: 1,
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
    buildVersion: '0.0.0-poc',
    ...overrides
  }
}

function harnessIdentity(overrides: Record<string, unknown> = {}) {
  return {
    component: 'harness',
    runtime: 'bare',
    instanceId: 'harness-mobile-test',
    processId: 2,
    contract: 'qvac.harness',
    protocolVersion: 2,
    capabilities: [
      'agent.register',
      'agent.run',
      'agent.cancel',
      'run.read',
      'work.watch',
      'state.port'
    ],
    buildVersion: '0.0.0-poc',
    ...overrides
  }
}

async function waitFor(predicate: () => boolean) {
  const deadline = Date.now() + 2_000
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('timed out waiting for lifecycle event')
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}
