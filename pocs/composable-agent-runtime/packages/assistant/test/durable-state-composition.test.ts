import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import createTestnet from 'hyperdht/testnet.js'
import {
  createHarness,
  type DurableStateInput
} from '@qvac/harness'
import {
  createSync,
  type SyncRuntime
} from '@qvac/sync'
import {
  durableWorkProfile as syncDurableWorkProfile,
  type DurableWorkCommand as SyncDurableWorkCommand,
  type DurableWorkQuery as SyncDurableWorkQuery,
  type DurableWorkResult as SyncDurableWorkResult
} from '@qvac/sync/profiles/durable-work'
import {
  durableWorkProfile as harnessDurableWorkProfile,
  durableWorkProfileCapabilities,
  type DurableWorkCommand as HarnessDurableWorkCommand,
  type DurableWorkQuery as HarnessDurableWorkQuery,
  type DurableWorkResult as HarnessDurableWorkResult
} from '../../harness/lib/durable-work-profile.ts'

type Assert<T extends true> = T
type Extends<Left, Right> = [Left] extends [Right] ? true : false

type SyncRuntimeIsDurableStateInput = Assert<
  Extends<SyncRuntime, DurableStateInput>
>
type HarnessCommandsFitSync = Assert<
  Extends<HarnessDurableWorkCommand, SyncDurableWorkCommand>
>
type HarnessQueriesFitSync = Assert<
  Extends<HarnessDurableWorkQuery, SyncDurableWorkQuery>
>
type SyncWorkFieldsFitHarness = Assert<
  Extends<
    Pick<NonNullable<SyncDurableWorkResult['work']>, 'workId' | 'outcomeResult'>,
    Pick<
      NonNullable<HarnessDurableWorkResult['work']>,
      'workId' | 'outcomeResult'
    >
  >
>
type SyncJournalFieldsFitHarness = Assert<
  Extends<
    Pick<SyncDurableWorkResult['entries'][number], 'body'>,
    Pick<HarnessDurableWorkResult['entries'][number], 'body'>
  >
>
type SyncCheckpointFieldsFitHarness = Assert<
  Extends<
    Pick<NonNullable<SyncDurableWorkResult['checkpoint']>, 'blobRef'>,
    Pick<NonNullable<HarnessDurableWorkResult['checkpoint']>, 'blobRef'>
  >
>

void (null as SyncRuntimeIsDurableStateInput | null)
void (null as HarnessCommandsFitSync | null)
void (null as HarnessQueriesFitSync | null)
void (null as SyncWorkFieldsFitHarness | null)
void (null as SyncJournalFieldsFitHarness | null)
void (null as SyncCheckpointFieldsFitHarness | null)

describe('durable state composition', () => {
  it('persists harness run state through real Sync reopen', async () => {
    const cleanups: (() => void | Promise<void>)[] = []
    const dir = await mkdtemp(path.join(tmpdir(), 'qvac-durable-state-'))
    const testnet = await createTestnet(3, {
      teardown: (cleanup: () => void | Promise<void>) => {
        cleanups.push(cleanup)
      }
    })
    const storagePath = path.join(dir, 'sync-agent-state')
    let sync = createSync({
      storagePath,
      bootstrap: testnet.bootstrap
    })
    let harness: ReturnType<typeof createHarness> | null = null
    try {
      await sync.ready()
      harness = createHarness({
        state: sync,
        inference: 'deterministic'
      })
      await harness.ready()
      await harness.registerAgent({
        id: 'agent-1',
        model: 'deterministic',
        skills: [],
        toolPolicy: { allow: [], requireApproval: [] }
      })
      const events = []
      for await (const event of harness.runAgent({
        agentId: 'agent-1',
        runId: 'run-1',
        input: 'hello'
      })) {
        events.push(event)
      }
      expect(events.some((event) => event.type === 'error')).toBe(false)
      expect(await harness.readRun({ agentId: 'agent-1', runId: 'run-1' }))
        .not.toBeNull()
      await harness.close()
      await sync.close()

      sync = createSync({
        storagePath,
        bootstrap: testnet.bootstrap
      })
      await sync.ready()
      harness = createHarness({
        state: sync,
        inference: 'deterministic'
      })
      await harness.ready()
      const loaded = await harness.readRun({
        agentId: 'agent-1',
        runId: 'run-1'
      })
      expect(loaded?.events.length).toBeGreaterThan(0)
      expect(loaded?.checkpoint?.runId).toBe('run-1')
    } finally {
      await harness?.close().catch(() => {})
      await sync.close().catch(() => {})
      for (const cleanup of cleanups.reverse()) await cleanup()
      await rm(dir, { recursive: true, force: true })
    }
  }, 90_000)

  it('keeps harness durable-work profile aligned with Sync registration', () => {
    expect(harnessDurableWorkProfile.id).toBe(syncDurableWorkProfile.id)
    expect(harnessDurableWorkProfile.version).toBe(syncDurableWorkProfile.version)
    for (const capability of durableWorkProfileCapabilities) {
      expect(syncDurableWorkProfile.capabilities).toContain(capability)
    }
  })
})
