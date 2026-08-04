import { mkdtemp, rm } from 'node:fs/promises'
import { Buffer } from 'node:buffer'
import os from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import stow from 'bare-stow'
import { argvForLogging } from '../logger.ts'
import { spawnHarness, type SpawnedHarness } from '../spawn.ts'
import type { HarnessRunStore } from '../run-store.ts'
import type { HarnessLoggingConfig } from '../types.ts'
import type { HarnessDesktopConfig } from './desktop-config.ts'

export interface LaunchDesktopHarnessOptions {
  readonly inference: 'deterministic' | 'qwen'
  readonly logging?: HarnessLoggingConfig
  readonly runStore: HarnessRunStore
  readonly desktop?: HarnessDesktopConfig
}

export interface DesktopHarnessWorker {
  readonly client: SpawnedHarness
  close(): Promise<void>
}

export async function launchDesktopHarness({
  inference,
  logging,
  runStore,
  desktop
}: LaunchDesktopHarnessOptions): Promise<DesktopHarnessWorker> {
  const directory = await mkdtemp(
    fileURLToPath(
      new URL('../../../../.stow-harness-', import.meta.url).href
    )
  )
  try {
    const [harnessEntry, sdkEntry, sandboxEntry] = await Promise.all([
      buildBundle(
        directory,
        'harness',
        new URL('../../child-entry.ts', import.meta.url).href
      ),
      buildBundle(
        directory,
        `${inference}-sdk`,
        new URL(
          inference === 'deterministic'
            ? '../../deterministic-sdk-entry.ts'
            : '../../qwen-sdk-entry.ts',
          import.meta.url
        ).href
      ),
      desktop
        ? buildBundle(
            directory,
            'tool-sandbox',
            new URL('../../tool-sandbox-child-entry.ts', import.meta.url).href
          )
        : Promise.resolve(undefined)
    ])
    const client = spawnHarness({
      entry: harnessEntry,
      args: [
        `--sdk-entry=${sdkEntry}`,
        ...(desktop && sandboxEntry
          ? [
              `--desktop-config=${Buffer.from(
                JSON.stringify({ ...desktop, childEntry: sandboxEntry })
              ).toString('base64')}`
            ]
          : []),
        ...argvForLogging(logging)
      ],
      runStore
    })
    let closed: Promise<void> | null = null
    return {
      client,
      close() {
        if (closed) return closed
        closed = (async () => {
          try {
            await client.close()
          } finally {
            await rm(directory, { recursive: true, force: true })
          }
        })()
        return closed
      }
    }
  } catch (error) {
    await rm(directory, { recursive: true, force: true })
    throw error
  }
}

async function buildBundle(directory: string, name: string, entry: string) {
  const output = pathToFileURL(join(directory, `${name}.js`))
  const artifacts = stow(entry, 'bare-sidecar', output.href, {
    base: new URL('../../../../', import.meta.url).href,
    hosts: [`${os.platform()}-${os.arch()}`]
  })
  for await (const _artifact of artifacts);
  return join(directory, `${name}.bundle`)
}
