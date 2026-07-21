import {
  spawnHarness,
  type HarnessEvent,
  type HarnessStateAdapter,
  type HarnessRuntime
} from '@qvac/harness'
import type {
  RuntimeHandshake,
  RuntimeLoggingConfig
} from '@qvac/runtime-contracts'
import {
  spawnSync,
  type SyncCoreOptions
} from '@qvac/sync'
import { mkdir } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import type {
  AssistantHarnessComponent,
  AssistantInference,
  AssistantStateEndpoint,
  AssistantSyncComponent
} from './contracts.ts'

const BUILD_VERSION = '0.0.0-poc'

export function syncHandshake(): RuntimeHandshake {
  return {
    contract: 'qvac.sync',
    protocolVersion: 1,
    capabilities: [
      'local-profile',
      'tasks',
      'task-watches',
      'passive-replication'
    ],
    requiredPeerCapabilities: [],
    buildVersion: BUILD_VERSION
  }
}

export function harnessHandshake(): RuntimeHandshake {
  return {
    contract: 'qvac.harness',
    protocolVersion: 1,
    capabilities: ['execution.run', 'state.sync'],
    requiredPeerCapabilities: [],
    buildVersion: BUILD_VERSION
  }
}

export function expectedSyncHandshake(): RuntimeHandshake {
  return {
    ...syncHandshake(),
    requiredPeerCapabilities: ['local-profile', 'tasks', 'task-watches']
  }
}

export function expectedHarnessHandshake(): RuntimeHandshake {
  return {
    ...harnessHandshake(),
    requiredPeerCapabilities: ['execution.run', 'state.sync']
  }
}

export async function startSyncComponent(
  options: SyncCoreOptions
): Promise<AssistantSyncComponent> {
  const entry = await bundledEntry(
    'sync',
    new URL('../../sync/sidecar-entry.ts', import.meta.url),
    new URL('../../sync/', import.meta.url)
  )
  const client = await spawnSync({ entry, ...options })
  const identity = await client.describeRuntime()
  return {
    handshake: handshakeFrom(identity),
    state: client,
    exited: client.exited,
    close: () => client.close(),
    inspect: () => ({ ...identity })
  }
}

export async function startHarnessComponent(
  state: AssistantStateEndpoint,
  inference: AssistantInference,
  onSdkStart: () => void,
  logging?: RuntimeLoggingConfig
): Promise<AssistantHarnessComponent> {
  const stateAdapter = createSyncStateAdapter(state)
  const harnessEntry = await bundledEntry(
    'harness',
    new URL('../../harness/child-entry.ts', import.meta.url),
    new URL('../../../', import.meta.url)
  )
  const sdkEntry =
    inference.kind === 'deterministic'
      ? new URL('../../harness/deterministic-sdk-entry.ts', import.meta.url)
      : new URL('../../harness/qwen-sdk-entry.ts', import.meta.url)
  const args = [
    `--sdk-entry=${await bundledEntry(
      `${inference.kind}-sdk`,
      sdkEntry,
      new URL('../../../', import.meta.url)
    )}`,
    `--logging=${JSON.stringify(logging ?? {})}`
  ]
  const remote = spawnHarness({ entry: harnessEntry, args })
  let identity = await remote.describeRuntime()
  let sdkStarted = false
  const harness: HarnessRuntime = {
    async *run(input) {
      for await (const event of remote.run(input)) {
        await stateAdapter.append(input.runId, event)
        yield event
      }
      identity = await remote.describeRuntime()
      if (!sdkStarted && identity.sdkIdentity) {
        sdkStarted = true
        onSdkStart()
      }
    },
    close: () => remote.close()
  }
  return {
    handshake: handshakeFrom(identity),
    harness,
    exited: remote.exited,
    readRun: stateAdapter.read,
    close: () => harness.close(),
    inspect: () => ({ ...identity })
  }
}

function handshakeFrom(identity: {
  readonly contract: string
  readonly protocolVersion: number
  readonly capabilities: readonly string[]
  readonly buildVersion: string
}): RuntimeHandshake {
  return {
    contract: identity.contract,
    protocolVersion: identity.protocolVersion,
    capabilities: [...identity.capabilities],
    requiredPeerCapabilities: [],
    buildVersion: identity.buildVersion
  }
}

const bundles = new Map<string, Promise<string>>()

function bundledEntry(name: string, entry: URL, base: URL) {
  const existing = bundles.get(name)
  if (existing) return existing
  const building = buildBundle(name, entry, base)
  bundles.set(name, building)
  return building
}

async function buildBundle(name: string, entry: URL, base: URL) {
  const directory = fileURLToPath(
    new URL(`../../../.stow-assistant-${process.pid}/`, import.meta.url)
  )
  await mkdir(directory, { recursive: true })
  const output = join(directory, `${name}.js`)
  const stowCli = fileURLToPath(
    new URL('../../../node_modules/bare-stow/bin.js', import.meta.url)
  )
  await runStow([
    stowCli,
    fileURLToPath(entry),
    '--target',
    'bare-sidecar',
    '--base',
    fileURLToPath(base),
    '--out',
    output,
    '--host',
    `${process.platform}-${process.arch}`
  ])
  return fileURLToPath(pathToFileURL(join(directory, `${name}.bundle`)))
}

function runStow(args: readonly string[]) {
  return new Promise<void>((resolve, reject) => {
    const child = spawn(process.execPath, [...args], {
      stdio: ['ignore', 'ignore', 'pipe']
    })
    const errors: Buffer[] = []
    child.stderr.on('data', (chunk: Buffer) => errors.push(chunk))
    child.once('error', reject)
    child.once('close', (code) => {
      if (code === 0) {
        resolve()
        return
      }
      reject(
        new Error(
          `bare-stow failed for runtime bundle (${code ?? 'unknown'}): ${Buffer.concat(errors).toString().trim()}`
        )
      )
    })
  })
}

function createSyncStateAdapter(
  state: AssistantStateEndpoint
): HarnessStateAdapter {
  return {
    async append(runId, event) {
      const id = runStateId(runId)
      const current = await state.getTask({ id })
      const events = current.task?.result ? parseEvents(current.task.result) : []
      events.push(event)
      if (!current.task) {
        await state.createTask({
          id,
          title: `Harness run ${runId}`,
          input: runId
        })
      }
      await state.updateTask({
        id,
        status: eventStatus(event),
        result: JSON.stringify(events)
      })
    },
    async read(runId) {
      const result = await state.getTask({ id: runStateId(runId) })
      return result.task?.result ? parseEvents(result.task.result) : []
    },
    async close() {}
  }
}

function runStateId(runId: string) {
  return `@harness/${runId}`
}

function eventStatus(event: HarnessEvent) {
  if (event.type === 'error') return 'failed' as const
  if (event.type === 'aborted') return 'cancelled' as const
  return 'running' as const
}

function parseEvents(serialized: string): HarnessEvent[] {
  const parsed = JSON.parse(serialized)
  if (!Array.isArray(parsed) || !parsed.every(isHarnessEvent)) {
    throw new Error('Invalid persisted Harness event stream')
  }
  return parsed
}

function isHarnessEvent(
  value: object | string | number | boolean | null
): value is HarnessEvent {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false
  }
  const type = Reflect.get(value, 'type')
  return (
    type === 'content' ||
    type === 'thinking' ||
    type === 'tool-call' ||
    type === 'tool-result' ||
    type === 'metrics' ||
    type === 'error' ||
    type === 'aborted'
  )
}
