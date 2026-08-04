import type {
  SyncDurableWork,
  SyncDurableWorkCheckpoint,
  SyncDurableWorkExecutor,
  SyncDurableWorkGate,
  SyncDurableWorkJournalEntry
} from '../../../spec/mesh/hyperschema/types.d.ts'
import { decodeProfileValue, encodeProfileValue } from '../codec.ts'
import type {
  ProfileApplyContext,
  SyncProfileRuntime
} from '../profile-runtime.ts'
import {
  durableWorkProfile,
  type DurableWorkCommand,
  type DurableWorkQuery,
  type DurableWorkResult
} from './contract.ts'

const WORK = '@sync/durable-work'
const JOURNAL = '@sync/durable-work-journal'
const CHECKPOINTS = '@sync/durable-work-checkpoints'
const GATES = '@sync/durable-work-gates'
const EXECUTORS = '@sync/durable-work-executors'

type PreparedCommand = DurableWorkCommand & {
  readonly recordedAt: number
}

export const durableWorkRuntime: SyncProfileRuntime = {
  id: durableWorkProfile.id,
  version: durableWorkProfile.version,
  prepare(command, context) {
    const decoded = decodeProfileValue<DurableWorkCommand>(command)
    validateCommand(decoded)
    return encodeProfileValue({
      ...decoded,
      recordedAt: context.recordedAt
    })
  },
  async apply(command, context) {
    const decoded = decodeProfileValue<PreparedCommand>(command)
    return applyCommand(decoded, context)
  },
  async query(query, database) {
    const decoded = decodeProfileValue<DurableWorkQuery>(query)
    const empty: DurableWorkResult = {
      works: [],
      entries: [],
      executors: []
    }
    if (decoded.type === 'get-work') {
      return encodeProfileValue({
        ...empty,
        work: await database.get<SyncDurableWork>(WORK, {
          workId: decoded.workId
        })
      })
    }
    if (decoded.type === 'get-checkpoint-ref') {
      return encodeProfileValue({
        ...empty,
        checkpoint: await database.get<SyncDurableWorkCheckpoint>(
          CHECKPOINTS,
          { workId: decoded.workId }
        )
      })
    }
    if (decoded.type === 'list-journal') {
      const entries = await database
        .find<SyncDurableWorkJournalEntry>(JOURNAL)
        .toArray()
      return encodeProfileValue({
        ...empty,
        entries: entries
          .filter(({ workId }) => workId === decoded.workId)
          .sort(compareRecordedRows)
      })
    }
    if (decoded.type === 'list-executor-presence') {
      return encodeProfileValue({
        ...empty,
        executors: await database.find<SyncDurableWorkExecutor>(EXECUTORS).toArray()
      })
    }
    const works = await database.find<SyncDurableWork>(WORK).toArray()
    if (decoded.type === 'list-work') {
      return encodeProfileValue({
        ...empty,
        works: works.sort(compareWork)
      })
    }
    return encodeProfileValue({
      ...empty,
      works: works.filter(
        ({ cancelRequested, outcomeStatus }) =>
          !cancelRequested && outcomeStatus == null
      ).sort(compareWork)
    })
  }
}

async function applyCommand(
  command: PreparedCommand,
  context: ProfileApplyContext
) {
  if (command.type === 'record-work') {
    const existing = await context.transaction.get<SyncDurableWork>(WORK, {
      workId: command.workId
    })
    if (existing) return false
    await context.transaction.insert<SyncDurableWork>(WORK, {
      workId: command.workId,
      payload: command.payload,
      payloadFormat: command.payloadFormat,
      payloadVersion: command.payloadVersion,
      target: command.target,
      createdAt: command.recordedAt,
      cancelRequested: false
    })
    return true
  }

  if (command.type === 'append-journal') {
    if (!(await workExists(command.workId, context))) return false
    await context.transaction.insert<SyncDurableWorkJournalEntry>(JOURNAL, {
      id: context.revision,
      workId: command.workId,
      entryType: command.entryType,
      body: command.body,
      recordedAt: command.recordedAt
    })
    return true
  }

  if (command.type === 'save-checkpoint-ref') {
    if (!(await workExists(command.workId, context))) return false
    await context.transaction.insert<SyncDurableWorkCheckpoint>(CHECKPOINTS, {
      workId: command.workId,
      checkpointId: command.checkpointId,
      format: command.format,
      version: command.version,
      blobRef: command.blobRef,
      recordedAt: command.recordedAt
    })
    return true
  }

  if (command.type === 'open-gate') {
    if (!(await workExists(command.workId, context))) return false
    await context.transaction.insert<SyncDurableWorkGate>(GATES, {
      id: gateKey(command.workId, command.gateId),
      workId: command.workId,
      gateId: command.gateId,
      kind: command.kind,
      recordedAt: command.recordedAt
    })
    return true
  }

  if (command.type === 'resolve-gate') {
    const id = gateKey(command.workId, command.gateId)
    const existing = await context.transaction.get<SyncDurableWorkGate>(GATES, {
      id
    })
    if (!existing || existing.decision != null) return false
    await context.transaction.insert<SyncDurableWorkGate>(GATES, {
      ...existing,
      decision: command.decision,
      recordedAt: command.recordedAt
    })
    return true
  }

  if (command.type === 'advertise-executor') {
    await context.transaction.insert<SyncDurableWorkExecutor>(EXECUTORS, {
      executorId: command.executorId,
      capabilities: [...command.capabilities],
      expiresAt: command.expiresAt,
      recordedAt: command.recordedAt
    })
    return true
  }

  const existing = await context.transaction.get<SyncDurableWork>(WORK, {
    workId: command.workId
  })
  if (!existing) return false
  if (existing.outcomeStatus != null) return false
  if (command.type === 'request-cancel') {
    if (existing.cancelRequested) return false
    await context.transaction.insert<SyncDurableWork>(WORK, {
      ...existing,
      cancelRequested: true,
      cancelReason: command.reason
    })
    return true
  }
  await context.transaction.insert<SyncDurableWork>(WORK, {
    ...existing,
    outcomeStatus: command.status,
    outcomeResult: command.result
  })
  return true
}

async function workExists(workId: string, context: ProfileApplyContext) {
  return (
    (await context.transaction.get<SyncDurableWork>(WORK, { workId })) != null
  )
}

function validateCommand(command: DurableWorkCommand) {
  if ('workId' in command && !command.workId.trim()) {
    throw new Error('Durable work id is required')
  }
  if (command.type === 'record-work') {
    if (!command.payloadFormat.trim()) {
      throw new Error('Durable work payload format is required')
    }
    if (!Number.isSafeInteger(command.payloadVersion) || command.payloadVersion < 1) {
      throw new Error('Durable work payload version must be a positive integer')
    }
  }
  if (command.type === 'advertise-executor' && !command.executorId.trim()) {
    throw new Error('Executor id is required')
  }
}

function gateKey(workId: string, gateId: string) {
  return `${workId}:${gateId}`
}

function compareRecordedRows(
  left: SyncDurableWorkJournalEntry,
  right: SyncDurableWorkJournalEntry
) {
  if (left.recordedAt !== right.recordedAt) {
    return left.recordedAt - right.recordedAt
  }
  return left.id.localeCompare(right.id)
}

function compareWork(left: SyncDurableWork, right: SyncDurableWork) {
  if (left.createdAt !== right.createdAt) return left.createdAt - right.createdAt
  return left.workId.localeCompare(right.workId)
}
