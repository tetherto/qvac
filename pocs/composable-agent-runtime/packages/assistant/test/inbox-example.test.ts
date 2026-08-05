import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  createInboxRepository,
  decodeInvite,
  encodeInvite,
  parseInboxCommand,
  resolveInboxPaths
} from '../examples/assistant-inbox.ts'

describe('assistant inbox example', () => {
  it('uses role-specific temp storage by default', () => {
    expect(resolveInboxPaths('default')).toEqual({
      root: join(tmpdir(), 'qvac-assistant-inbox', 'default'),
      hostStoragePath: join(tmpdir(), 'qvac-assistant-inbox', 'default', 'host'),
      peerStoragePath: join(tmpdir(), 'qvac-assistant-inbox', 'default', 'peer'),
      invitePath: join(tmpdir(), 'qvac-assistant-inbox', 'default', 'invite.json')
    })
  })

  it('parses serve, add, and status without storage flags', () => {
    expect(parseInboxCommand(['serve'])).toMatchObject({
      mode: 'serve',
      profile: 'default'
    })
    expect(parseInboxCommand(['add', 'Draft', 'release', 'notes'])).toMatchObject({
      mode: 'add',
      profile: 'default',
      text: 'Draft release notes'
    })
    expect(parseInboxCommand(['status'])).toMatchObject({
      mode: 'status',
      profile: 'default'
    })
  })

  it('accepts a named profile and pasted invite for remote peers', () => {
    const invite = Buffer.from('invite-secret')
    const encoded = encodeInvite(invite)
    expect(decodeInvite(encoded).toString('utf8')).toBe('invite-secret')
    expect(
      parseInboxCommand(['add', '--profile', 'demo', '--invite', encoded, 'hello'])
    ).toMatchObject({
      mode: 'add',
      profile: 'demo',
      text: 'hello',
      invite
    })
  })

  it('records and updates durable inbox tasks through the work endpoint', async () => {
    const profile = createFakeWorkProfile()
    const inbox = createInboxRepository({ work: profile })

    const created = await inbox.create('Review package boundaries')
    expect(created).toMatchObject({
      input: 'Review package boundaries',
      status: 'pending',
      result: null
    })

    await inbox.update({
      id: created.id,
      status: 'running',
      result: 'started'
    })
    await inbox.update({
      id: created.id,
      status: 'completed',
      result: 'done'
    })

    expect(await inbox.list()).toMatchObject([
      {
        id: created.id,
        input: 'Review package boundaries',
        status: 'completed',
        result: 'done'
      }
    ])
  })
})

function createFakeWorkProfile() {
  const works = new Map<
    string,
    {
      payload: Buffer
      payloadFormat: string
      outcomeStatus: string | null
      outcomeResult: Buffer | null
      createdAt: number
    }
  >()
  const journals = new Map<string, Array<{ entryType: string; body: Buffer; recordedAt: number }>>()
  let clock = 0

  return {
    async apply(command: Record<string, unknown>) {
      clock++
      if (command.type === 'record-work') {
        works.set(String(command.workId), {
          payload: command.payload as Buffer,
          payloadFormat: String(command.payloadFormat),
          outcomeStatus: null,
          outcomeResult: null,
          createdAt: clock
        })
      } else if (command.type === 'append-journal') {
        const entries = journals.get(String(command.workId)) ?? []
        entries.push({
          entryType: String(command.entryType),
          body: command.body as Buffer,
          recordedAt: clock
        })
        journals.set(String(command.workId), entries)
      } else if (command.type === 'record-outcome') {
        const work = works.get(String(command.workId))
        if (!work) throw new Error('missing work')
        work.outcomeStatus = String(command.status)
        work.outcomeResult = command.result as Buffer
      }
      return { revision: String(clock) }
    },
    async query(query: Record<string, unknown>) {
      if (query.type === 'list-work') {
        return {
          works: [...works.entries()].map(([workId, work]) => ({
            workId,
            payloadFormat: work.payloadFormat,
            createdAt: work.createdAt,
            outcomeStatus: work.outcomeStatus,
            outcomeResult: work.outcomeResult
          }))
        }
      }
      if (query.type === 'get-work') {
        const work = works.get(String(query.workId))
        return {
          work: work
            ? {
                workId: String(query.workId),
                payload: work.payload,
                payloadFormat: work.payloadFormat,
                createdAt: work.createdAt,
                outcomeStatus: work.outcomeStatus,
                outcomeResult: work.outcomeResult
              }
            : null
        }
      }
      if (query.type === 'list-journal') {
        return { entries: journals.get(String(query.workId)) ?? [] }
      }
      throw new Error(`unsupported query: ${String(query.type)}`)
    },
    watch() {
      return (async function* () {})()
    }
  }
}
