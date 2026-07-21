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
import { mkdtemp, rm } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
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
      'passive-replication',
      'writer-pairing'
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
    requiredPeerCapabilities: [
      'local-profile',
      'tasks',
      'task-watches',
      'writer-pairing'
    ]
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
  const bundles = acquireBundleLease()
  try {
    const entry = await bundles.entry(
      'sync',
      new URL('../../sync/sidecar-entry.ts', import.meta.url),
      new URL('../../sync/', import.meta.url)
    )
    const client = await spawnSync({ entry, ...options })
    const identity = await client.describeRuntime()
    const close = closeWithRelease(() => client.close(), bundles.release)
    return {
      handshake: handshakeFrom(identity),
      state: client,
      exited: client.exited,
      close,
      inspect: () => ({ ...identity })
    }
  } catch (error) {
    await bundles.release()
    throw error
  }
}

export async function startHarnessComponent(
  state: AssistantStateEndpoint,
  inference: AssistantInference,
  onSdkStart: () => void,
  logging?: RuntimeLoggingConfig
): Promise<AssistantHarnessComponent> {
  const bundles = acquireBundleLease()
  const stateAdapter = createSyncStateAdapter(state)
  try {
    const harnessEntry = await bundles.entry(
      'harness',
      new URL('../../harness/child-entry.ts', import.meta.url),
      new URL('../../../', import.meta.url)
    )
    const sdkEntry =
      inference.kind === 'deterministic'
        ? new URL('../../harness/deterministic-sdk-entry.ts', import.meta.url)
        : new URL('../../harness/qwen-sdk-entry.ts', import.meta.url)
    const args = [
      `--sdk-entry=${await bundles.entry(
        `${inference.kind}-sdk`,
        sdkEntry,
        new URL('../../../', import.meta.url)
      )}`,
      `--logging=${JSON.stringify(logging ?? {})}`
    ]
    const remote = spawnHarness({ entry: harnessEntry, args })
    let identity = await remote.describeRuntime()
    let sdkStarted = false
    const close = closeWithRelease(() => remote.close(), bundles.release)
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
      close
    }
    return {
      handshake: handshakeFrom(identity),
      harness,
      exited: remote.exited,
      readRun: stateAdapter.read,
      close,
      inspect: () => ({ ...identity })
    }
  } catch (error) {
    await bundles.release()
    throw error
  }
}

interface BundleOwner {
  readonly directory: Promise<string>
  readonly bundles: Map<string, Promise<string>>
  leases: number
}

interface BundleLease {
  entry(name: string, entry: URL, base: URL): Promise<string>
  release(): Promise<void>
}

let activeBundleOwner: BundleOwner | null = null

function acquireBundleLease(): BundleLease {
  const owner = activeBundleOwner ?? createBundleOwner()
  activeBundleOwner = owner
  owner.leases++
  let released = false
  return {
    entry(name, entry, base) {
      const existing = owner.bundles.get(name)
      if (existing) return existing
      const building = buildBundle(owner.directory, name, entry, base)
      owner.bundles.set(name, building)
      return building
    },
    async release() {
      if (released) return
      released = true
      owner.leases--
      if (owner.leases !== 0) return
      if (activeBundleOwner === owner) activeBundleOwner = null
      await rm(await owner.directory, { force: true, recursive: true })
    }
  }
}

function createBundleOwner(): BundleOwner {
  return {
    directory: mkdtemp(
      fileURLToPath(new URL('../../../.stow-assistant-', import.meta.url))
    ),
    bundles: new Map(),
    leases: 0
  }
}

function closeWithRelease(
  close: () => Promise<void>,
  release: () => Promise<void>
) {
  let closed: Promise<void> | null = null
  return function closeOnce() {
    if (closed) return closed
    closed = (async () => {
      try {
        await close()
      } finally {
        await release()
      }
    })()
    return closed
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

async function buildBundle(
  directoryPromise: Promise<string>,
  name: string,
  entry: URL,
  base: URL
) {
  const directory = await directoryPromise
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
  return join(directory, `${name}.bundle`)
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
