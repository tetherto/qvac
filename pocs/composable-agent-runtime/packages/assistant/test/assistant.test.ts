import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it, onTestFinished } from 'vitest'
import {
  createAssistant,
  DEFAULT_ASSISTANT_INFERENCE,
  DEFAULT_ASSISTANT_STORAGE_PATH
} from '../index.ts'
import type {
  AssistantComponent,
  AssistantHarnessComponent,
  AssistantSyncComponent
} from '../lib/contracts.ts'
import { createAssistantFacade } from '../lib/facade.ts'

const temporaryPaths: string[] = []

afterEach(async () => {
  await Promise.all(
    temporaryPaths.splice(0).map((path) => rm(path, { force: true, recursive: true }))
  )
})

describe('assistant composition', () => {
  it('defaults durable state to .assistant', () => {
    expect(DEFAULT_ASSISTANT_STORAGE_PATH).toBe('.assistant')
    expect(DEFAULT_ASSISTANT_INFERENCE).toEqual({ kind: 'qwen' })
  })

  it('starts and restarts package-owned runtimes with installed config', async () => {
    const storagePath = await mkdtemp(join(tmpdir(), 'qvac-assistant-'))
    temporaryPaths.push(storagePath)
    const assistant = createAssistant({
      storagePath,
      sync: { bootstrap: [] },
      inference: { kind: 'deterministic' }
    })
    onTestFinished(() => assistant.close())
    const state = assistant.state
    const identity = state.mesh.identity()

    await assistant.ready()
    expect(assistant.state).toBe(state)
    expect((await identity).deviceId.byteLength).toBeGreaterThan(0)
    expect(assistant.inspect()).toMatchObject({
      children: [
        {
          name: 'sync',
          state: 'running',
          details: {
            component: 'sync',
            runtime: 'bare',
            instanceId: expect.stringMatching(/^sync-/),
            processId: expect.any(Number)
          }
        },
        {
          name: 'harness',
          state: 'running',
          deps: ['sync'],
          details: {
            component: 'harness',
            runtime: 'bare',
            instanceId: expect.stringMatching(/^harness-/),
            processId: expect.any(Number)
          }
        }
      ]
    })
    const startupProcessIds = assistant
      .inspect()
      .children.map((child) => child.details?.processId)
    expect(new Set(startupProcessIds).size).toBe(2)
    expect(startupProcessIds).not.toContain(process.pid)

    await state.mesh.renameDevice('Ada')
    expect((await state.mesh.listDevices()).find(({ local }) => local)?.name).toBe('Ada')
    const pairingInvite = await assistant.state.mesh.createInvite()
    expect(pairingInvite.invite.byteLength).toBeGreaterThan(0)

    await assistant.registerAgent({
      id: 'assistant',
      model: 'deterministic',
      skills: [],
      toolPolicy: { allow: [], requireApproval: [] }
    })
    const run = assistant.run({
      agentId: 'assistant',
      input: 'sort the tasks'
    })
    expect(run.id).toMatch(/^run_[a-z0-9_]+$/)

    const events = []
    for await (const event of run) {
      events.push(event)
    }
    expect(events).toEqual([{ type: 'content', text: 'deterministic: sort the tasks' }])
    const persisted = await assistant.readRun({
      agentId: 'assistant',
      runId: run.id
    })
    expect(persisted?.events.map(({ kind, event }) => `${kind}:${event.type}`)).toEqual([
      'agent:run-started',
      'agent:operation-started',
      'agent:content',
      'agent:operation-completed',
      'agent:checkpoint',
      'agent:run-completed'
    ])
    expect(persisted?.outcome).toEqual({
      status: 'completed',
      output: 'deterministic: sort the tasks'
    })

    const firstSyncProcessId = startupProcessIds[0]
    expect(firstSyncProcessId).toEqual(expect.any(Number))
    process.kill(firstSyncProcessId as number, 'SIGTERM')
    await waitFor(() => {
      const [sync, harness] = assistant.inspect().children
      return sync?.lives === 2 && harness?.lives === 2
    })
    const restartedProcessIds = assistant
      .inspect()
      .children.map((child) => child.details?.processId)
    expect(restartedProcessIds[0]).not.toBe(firstSyncProcessId)
    expect(restartedProcessIds[1]).not.toBe(startupProcessIds[1])
    expect(assistant.state).toBe(state)
    expect((await state.mesh.listDevices()).find(({ local }) => local)?.name).toBe('Ada')

    const restartedEvents = []
    await assistant.registerAgent({
      id: 'assistant-after-restart',
      model: 'deterministic',
      skills: [],
      toolPolicy: { allow: [], requireApproval: [] }
    })
    for await (const event of assistant.run({
      agentId: 'assistant-after-restart',
      runId: 'run-after-sync-restart',
      input: 'resume work'
    })) {
      restartedEvents.push(event)
    }
    expect(restartedEvents).toEqual([
      { type: 'content', text: 'deterministic: resume work' }
    ])

  }, 75_000)

  it('rejects an incompatible child before starting its dependent', async () => {
    const starts: string[] = []
    const stops: string[] = []
    const sync = component('sync', starts, stops, {
      contract: 'qvac.sync',
      protocolVersion: 99
    }) as AssistantSyncComponent
    const assistant = createAssistantFacade(
      {},
      {
        startSync: async () => sync,
        startHarness: async () =>
          component('harness', starts, stops) as AssistantHarnessComponent
      }
    )

    await expect(assistant.ready()).rejects.toThrow(
      'sync handshake failed: protocol mismatch'
    )
    expect(starts).toEqual(['sync'])
    expect(stops).toEqual(['sync'])
  })

  it('closes Harness before Sync', async () => {
    const starts: string[] = []
    const stops: string[] = []
    const lifecycle: Array<{
      type: string
      name?: string
      timestamp: number
    }> = []
    const assistant = createAssistantFacade(
      {},
      {
        startSync: async () =>
          component('sync', starts, stops) as AssistantSyncComponent,
        startHarness: async () =>
          component('harness', starts, stops) as AssistantHarnessComponent
      }
    )
    const stopListening = assistant.onLifecycle((event) => {
      lifecycle.push(event)
    })

    await assistant.ready()
    await assistant.close()
    stopListening()

    expect(starts).toEqual(['sync', 'harness'])
    expect(stops).toEqual(['harness', 'sync'])
    expect(lifecycle.map(({ type, name }) => `${type}:${name}`)).toEqual([
      'child-ready:sync',
      'child-ready:harness',
      'child-stopped:harness',
      'child-stopped:sync'
    ])
    expect(lifecycle.every(({ timestamp }) => timestamp > 0)).toBe(true)
  })

  it('removes its temporary bundles after the last child closes', async () => {
    const storagePath = await mkdtemp(join(tmpdir(), 'qvac-assistant-'))
    temporaryPaths.push(storagePath)
    const before = await assistantBundleDirectories()
    const assistant = createAssistant({
      storagePath,
      sync: { bootstrap: [] },
      inference: { kind: 'deterministic' }
    })

    await assistant.ready()
    const during = await assistantBundleDirectories()
    const owned = during.filter((path) => !before.includes(path))
    expect(owned).toHaveLength(1)

    await assistant.close()

    expect(await assistantBundleDirectories()).not.toEqual(
      expect.arrayContaining(owned)
    )
  }, 45_000)
})

async function waitFor(predicate: () => boolean) {
  const deadline = Date.now() + 30_000
  while (!predicate()) {
    if (Date.now() >= deadline) {
      throw new Error('Timed out waiting for Assistant child restart')
    }
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
}

async function assistantBundleDirectories() {
  const root = fileURLToPath(new URL('../../../', import.meta.url))
  return (await readdir(root))
    .filter((name) => name.startsWith('.stow-harness-'))
    .sort()
}

function component(
  name: 'sync' | 'harness',
  starts: string[],
  stops: string[],
  handshake: Partial<AssistantComponent['handshake']> = {}
): AssistantComponent {
  starts.push(name)
  return {
    handshake: {
      contract: `qvac.${name}`,
      protocolVersion: name === 'sync' ? 1 : 2,
      capabilities:
        name === 'sync'
          ? [
              'profile-protocol',
              'durable-work',
              'passive-replication',
              'writer-pairing'
            ]
          : [
              'agent.register',
              'agent.run',
              'agent.cancel',
              'run.read',
              'work.watch',
              'state.port'
            ],
      requiredPeerCapabilities: [],
      buildVersion: '0.0.0-poc',
      ...handshake
    },
    close: async () => {
      stops.push(name)
    }
  }
}
