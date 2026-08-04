import {
  argvForLogging,
  spawnHarness,
  type HarnessRuntime
} from '@qvac/harness'
import {
  createSync,
  type CreateSyncOptions
} from '@qvac/sync'
import { mkdtemp, rm } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type {
  AssistantHarnessComponent,
  AssistantInference,
  CreateAssistantOptions,
  AssistantStateEndpoint,
  AssistantSyncComponent
} from './contracts.ts'
import { handshakeFrom } from './handshakes.ts'
import { createRunStateAdapter } from './run-state.ts'

export async function startSyncComponent(
  options: CreateSyncOptions
): Promise<AssistantSyncComponent> {
  const sync = createSync(options)
  await sync.ready()
  const identity = await sync.runtime.describe()
  return {
    handshake: handshakeFrom(identity),
    state: sync,
    exited: sync.exited,
    close: () => sync.close(),
    suspend: () => sync.lifecycle.suspend(),
    resume: () => sync.lifecycle.resume(),
    inspect: () => ({ ...identity })
  }
}

export async function startHarnessComponent(
  state: AssistantStateEndpoint,
  inference: AssistantInference,
  logging?: CreateAssistantOptions['logging']
): Promise<AssistantHarnessComponent> {
  const bundles = acquireBundleLease()
  const stateAdapter = createRunStateAdapter(state)
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
      ...argvForLogging(logging)
    ]
    const remote = spawnHarness({ entry: harnessEntry, args })
    let identity = await remote.describeRuntime()
    const close = closeWithRelease(async () => {
      await stateAdapter.close()
      await remote.close()
    }, bundles.release)
    const harness: HarnessRuntime = {
      async *run(input) {
        let completed = false
        try {
          for await (const event of remote.run(input)) {
            await stateAdapter.append(input.runId, event)
            yield event
          }
          identity = await remote.describeRuntime()
          completed = true
        } finally {
          await stateAdapter.finish(input.runId, completed)
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
