import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { ChatSession, transcript } from '../../dist/lib/client/chat-session.js'

// A watch that delivers each written frame synchronously, as the session's listeners expect.
class FakeWatch extends EventEmitter {
  write(frame) {
    this.emit('data', frame)
  }

  destroy() {
    queueMicrotask(() => this.emit('close'))
  }
}

function fixture(t) {
  const calls = [],
    events = [],
    streams = []
  const client = {
    chunksWatch(input) {
      calls.push(['watch', input])
      const stream = new FakeWatch()
      streams.push(stream)
      return stream
    }
  }
  for (const method of ['sendMessage', 'stopRun', 'resolveApproval']) {
    client[method] = (input) => {
      calls.push([method, input])
      return Promise.resolve({ chatId: input.chatId, runId: 'run' })
    }
  }

  const session = new ChatSession(client)
  t.after(() => session.close())
  session.attach({ meshId: 'project-mesh', chatId: 'chat' }, (event) => events.push(event))

  return { calls, events, streams, session }
}
const chunk = (seq, type, { runId = 'run', ...body } = {}) => ({
  id: `chunk-${seq}`,
  seq,
  type,
  runId,
  ...body
})

test('Core transcript snapshots coalesce streaming text and settle runs without duplication', () => {
  const chunks = [
    chunk(0, 'user-message', { userMessage: { text: 'Hello' } }),
    chunk(1, 'run-request'),
    chunk(2, 'content', { content: { text: 'Hi ' } }),
    chunk(3, 'content', { content: { text: 'there' } })
  ]
  let frame = transcript(chunks.toReversed())
  assert.equal(frame.messages.at(-1).text, 'Hi there')
  assert.equal(frame.runId, 'run')
  chunks.push(chunk(4, 'run-status', { runStatus: { state: 'completed' } }))
  frame = transcript(chunks)
  assert.equal(frame.messages.length, 2)
  assert.equal(frame.runId, null)
})

test('send, stop and one-time approval always target the selected project mesh', async (t) => {
  const { calls, streams, session } = fixture(t)
  assert.throws(() => session.send('wait'), /disconnected/)
  streams[0].write({
    chunks: [
      chunk(1, 'run-request'),
      chunk(2, 'approval-request', {
        approvalRequest: {
          status: 'pending',
          name: 'shell',
          arguments: { command: 'pwd' },
          agentId: 'agent'
        }
      })
    ]
  })
  await session.send('a\nb')
  await session.stop()
  await session.approve('chunk-2', true)
  assert.deepEqual(calls.slice(1), [
    ['sendMessage', { meshId: 'project-mesh', chatId: 'chat', text: 'a\nb' }],
    ['stopRun', { meshId: 'project-mesh', chatId: 'chat', runId: 'run' }],
    [
      'resolveApproval',
      {
        meshId: 'project-mesh',
        chunkId: 'chunk-2',
        approved: true,
        scope: 'once',
        agentId: 'agent'
      }
    ]
  ])
  streams[0].write({
    chunks: [
      chunk(2, 'approval-request', { approvalRequest: { status: 'approved', name: 'shell' } })
    ]
  })
  assert.throws(() => session.approve('chunk-2', true), /no longer pending/)
})

test('switching chat ignores old frames and stream errors disable mutations', (t) => {
  const { session, streams, events } = fixture(t)
  const late = streams[0].listeners('data')[0]
  session.attach({ meshId: 'other-project', chatId: 'other-chat' }, (event) => events.push(event))
  late({ chunks: [chunk(0, 'content', { content: { text: 'private old content' } })] })
  assert.equal(events.length, 0)
  streams[1].write({ chunks: [] })
  assert.equal(session.ready, true)
  streams[1].emit('error', new Error('connection lost'))
  assert.equal(session.ready, false)
  assert.throws(() => session.send('no'), /disconnected/)
  assert.equal(events.at(-1).connected, false)
})

test('completed runs never leave a stale approval actionable', () => {
  const frame = transcript([
    chunk(1, 'approval-request', { approvalRequest: { status: 'pending', name: 'write' } }),
    chunk(2, 'run-status', { runStatus: { state: 'canceled' } })
  ])
  assert.equal(frame.pending, null)
})
