import assert from 'node:assert/strict'
import test from 'node:test'
import { EventEmitter } from 'node:events'
import { ProjectSession } from '../../dist/lib/client/project-session.js'

function fixture() {
  const calls = []
  const streams = []
  const client = {}
  for (const method of ['projectsWatch', 'chatsWatch', 'knowledgeBaseWatch']) {
    client[method] = (args) => {
      calls.push({ method, args })
      const stream = new EventEmitter()
      stream.destroy = () => {
        stream.destroyed = true
        stream.emit('close')
      }
      streams.push(stream)

      return stream
    }
  }

  client.sendMessage = (args) => {
    calls.push({ method: 'sendMessage', args })
    return Promise.resolve({ chatId: 'c' })
  }

  return { client, calls, streams }
}

test('workspace listing and project content use different mesh scopes', async () => {
  const f = fixture()
  const session = new ProjectSession(f.client)
  session.select({ workspaceMeshId: 'w', projectMeshId: 'p' }, () => {})
  await session.send({ agentId: 'a', text: 'hello' })
  assert.deepEqual(
    f.calls.map((c) => c.args.meshId),
    ['w', 'p', 'p', 'p']
  )
  session.close()
  assert.ok(f.streams.every((s) => s.destroyed))
  assert.throws(() => session.send({ text: 'late' }), /Select a project/)
})

test('switching projects destroys old watches and suppresses queued old frames', () => {
  const f = fixture()
  const session = new ProjectSession(f.client)
  const events = []
  session.select({ workspaceMeshId: 'w', projectMeshId: 'p1' }, (e) => events.push(e))
  const queued = f.streams[1].listeners('data')[0]
  session.select({ workspaceMeshId: 'w', projectMeshId: 'p2' }, (e) => events.push(e))
  queued({ chats: [{ id: 'old' }] })
  f.streams[4].emit('data', { chats: [{ id: 'new' }] })
  assert.equal(events.length, 1)
  assert.equal(events[0].value.chats[0].id, 'new')
  assert.ok(f.streams.slice(0, 3).every((s) => s.destroyed))
  session.close()
})

test('partially opened watches close if a later subscription fails', () => {
  const f = fixture()
  f.client.chatsWatch = () => {
    throw new Error('unsupported')
  }
  const session = new ProjectSession(f.client)
  assert.throws(
    () => session.select({ workspaceMeshId: 'w', projectMeshId: 'p' }, () => {}),
    /unsupported/
  )
  assert.ok(f.streams[0].destroyed)
  assert.throws(() => session.send({ text: 'hello', agentId: 'a' }), /Select a project/)
})
