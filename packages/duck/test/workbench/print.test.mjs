import test from 'node:test'
import assert from 'node:assert/strict'
import { runPrint } from '../../dist/product/print.js'

function feed() {
  const queue = [],
    waiting = []
  let ended = false

  return {
    push(value) {
      const w = waiting.shift()
      if (w) {
        w({ value, done: false })
      } else {
        queue.push(value)
      }
    },
    [Symbol.asyncIterator]() {
      return {
        next: () => {
          if (queue.length) {
            return Promise.resolve({ value: queue.shift(), done: false })
          }

          if (ended) {
            return Promise.resolve({ done: true })
          }

          return new Promise((r) => waiting.push(r))
        },
        return: () => {
          ended = true
          for (const w of waiting.splice(0)) {
            w({ done: true })
          }

          return Promise.resolve({ done: true })
        }
      }
    }
  }
}

const chunk = (seq, type, { runId = 'run-1', ...body } = {}) => ({
  id: `chunk-${seq}`,
  seq,
  type,
  runId,
  ...body
})
const user = (seq, text) => ({
  id: `chunk-${seq}`,
  seq,
  type: 'user-message',
  userMessage: { text }
})
const content = (seq, text, runId) => chunk(seq, 'content', { content: { text }, runId })
const status = (seq, state, { runId, ...extra } = {}) =>
  chunk(seq, 'run-status', { runStatus: { state, ...extra }, runId })

// `script` maps a call name to the frames it pushes onto the open chat's watch.
function fakeEngine({ script = {}, existing = [], ...overrides } = {}) {
  const calls = [],
    watches = {},
    sent = []
  let chats = 0
  const watchOf = (chatId) => (watches[chatId] ||= feed())
  const play = (name, chatId) => {
    for (const frame of script[name] || []) {
      watchOf(chatId).push({ chunks: frame })
    }
  }

  return {
    calls,
    watches,
    accountWatch: () => [{ meshId: 'account' }],
    meshesWatch: () => [{ meshes: [{ meshId: 'account', writable: true }] }],
    agentsWatch: () => {
      const f = feed()
      f.push({
        agents: [{ id: 'agent-1', isDefault: true, providerDeviceId: 'aa', modelName: 'quack' }]
      })

      return f
    },
    getConfig: () => Promise.resolve({ activeChatId: 'chat-1', activeAgentId: 'agent-1' }),
    setConfig: (input) => Promise.resolve(calls.push(['setConfig', input])),
    listChats: () => Promise.resolve({ chats: [{ id: 'chat-0' }, { id: 'chat-1' }] }),
    chunksWatch: (input) => {
      calls.push(['chunksWatch', input])
      const f = watchOf(input.chatId)
      if (existing.length && !f.primed) {
        f.primed = true
        f.push({ chunks: existing })
      }

      return f
    },
    sendMessage: (input) => {
      calls.push(['sendMessage', input])
      const chatId = input.chatId || `chat-new-${++chats}`
      sent.push(input)
      setImmediate(() => play('sendMessage', chatId))
      return Promise.resolve({ chatId, runId: `run-${sent.length}` })
    },
    resolveApproval: (input) => {
      calls.push(['resolveApproval', input])
      setImmediate(() => play(input.approved ? 'approved' : 'denied', 'chat-new-1'))
      return Promise.resolve()
    },
    stopRun: (input) => Promise.resolve(calls.push(['stopRun', input])),
    updateAgent: (input) => {
      calls.push(['updateAgent', input])
      return Promise.resolve({ id: 'agent-1', modelName: input.config.modelName })
    },
    listModels: (input) => {
      calls.push(['listModels', input])
      return Promise.resolve({
        models: [
          { name: 'quack', type: 'completion', taskType: 'llm', isCached: true },
          { name: 'whisper', type: 'whisper', taskType: 'asr', isCached: true }
        ]
      })
    },
    ...overrides
  }
}

function io(stdin = null) {
  const out = [],
    err = []
  return {
    out,
    err,
    stdout: { write: (s) => out.push(s) },
    stderr: { write: (s) => err.push(s) },
    stdin: stdin === null ? null : stdin,
    get text() {
      return out.join('')
    },
    get events() {
      return out
        .join('')
        .trim()
        .split('\n')
        .map((l) => JSON.parse(l))
    }
  }
}

async function* from(...parts) {
  for (const part of parts) {
    await new Promise((r) => setImmediate(r))
    yield part
  }
}

const answer = [
  [user(0, 'hi'), chunk(1, 'run-request')],
  [user(0, 'hi'), chunk(1, 'run-request'), content(2, 'Hel')],
  [user(0, 'hi'), chunk(1, 'run-request'), content(2, 'Hel'), content(3, 'lo')],
  [
    user(0, 'hi'),
    chunk(1, 'run-request'),
    content(2, 'Hel'),
    content(3, 'lo'),
    status(4, 'completed')
  ]
]

test('print streams only the answer text and exits 0 on completed', async () => {
  const engine = fakeEngine({ script: { sendMessage: answer } })
  const t = io()
  const code = await runPrint(engine, {
    deviceId: 'aa',
    options: { mode: 'text', prompt: 'say hi' },
    io: t
  })
  assert.equal(code, 0)
  assert.deepEqual(t.out, ['Hel', 'lo', '\n'])
  assert.deepEqual(engine.calls.find((c) => c[0] === 'sendMessage')[1], {
    meshId: 'account',
    agentId: 'agent-1',
    text: 'say hi',
    title: 'say hi'
  })
  assert.deepEqual(engine.calls.find((c) => c[0] === 'setConfig')[1].activeChatId, 'chat-new-1')
})

test("a new chat from print carries the project's context files, and its title stays the prompt", async () => {
  const engine = fakeEngine({ script: { sendMessage: answer } })
  const t = io()
  t.context = 'The following context files contain project instructions.\n\n'
  await runPrint(engine, { deviceId: 'aa', options: { mode: 'text', prompt: 'say hi' }, io: t })
  const sent = engine.calls.find((c) => c[0] === 'sendMessage')[1]
  assert.equal(sent.text, 'The following context files contain project instructions.\n\nsay hi')
  assert.equal(sent.title, 'say hi')
})

test('a failed run exits 1 with its reason on stderr', async () => {
  const engine = fakeEngine({
    script: {
      sendMessage: [
        [user(0, 'hi'), content(1, 'par'), status(2, 'failed', { reason: 'model missing' })]
      ]
    }
  })
  const t = io()
  assert.equal(
    await runPrint(engine, { deviceId: 'aa', options: { mode: 'text', prompt: 'x' }, io: t }),
    1
  )
  assert.equal(t.text, 'par\n')
  assert.match(t.err.join(''), /run failed: model missing/)
})

test('piped stdin is prepended to the prompt, and stdin alone is a prompt', async () => {
  const engine = fakeEngine({ script: { sendMessage: answer } })
  await runPrint(engine, {
    deviceId: 'aa',
    options: { mode: 'text', prompt: 'review' },
    io: io(from('diff --git a\n', '+x\n'))
  })
  assert.equal(
    engine.calls.find((c) => c[0] === 'sendMessage')[1].text,
    'diff --git a\n+x\n\nreview'
  )
  const alone = fakeEngine({ script: { sendMessage: answer } })
  assert.equal(
    await runPrint(alone, {
      deviceId: 'aa',
      options: { mode: 'text' },
      io: io(from('just stdin\n'))
    }),
    0
  )
  assert.equal(alone.calls.find((c) => c[0] === 'sendMessage')[1].text, 'just stdin')
})

test('no prompt at all is a usage error', async () => {
  const t = io(from(''))
  assert.equal(
    await runPrint(fakeEngine(), { deviceId: 'aa', options: { mode: 'text' }, io: t }),
    2
  )
  assert.match(t.err.join(''), /no prompt/)
})

const asking = [
  [
    user(0, 'hi'),
    chunk(1, 'approval-request', {
      approvalRequest: {
        status: 'pending',
        name: 'bash',
        arguments: { cmd: 'ls' },
        agentId: 'agent-1'
      }
    })
  ]
]
const after = (state) => [
  [
    user(0, 'hi'),
    chunk(1, 'approval-request', {
      approvalRequest: { status: state, name: 'bash', agentId: 'agent-1' }
    }),
    content(2, state === 'approved' ? 'ran it' : 'skipped'),
    status(3, 'completed')
  ]
]

test('approvals are denied by default with a note', async () => {
  const engine = fakeEngine({ script: { sendMessage: asking, denied: after('denied') } })
  const t = io()
  assert.equal(
    await runPrint(engine, { deviceId: 'aa', options: { mode: 'text', prompt: 'x' }, io: t }),
    0
  )
  assert.deepEqual(engine.calls.find((c) => c[0] === 'resolveApproval')[1], {
    meshId: 'account',
    chunkId: 'chunk-1',
    approved: false,
    scope: 'once',
    agentId: 'agent-1'
  })
  assert.match(t.err.join(''), /denied bash/)
  assert.equal(t.text, 'skipped\n')
})

test('--yes approves once', async () => {
  const engine = fakeEngine({ script: { sendMessage: asking, approved: after('approved') } })
  const t = io()
  assert.equal(
    await runPrint(engine, {
      deviceId: 'aa',
      options: { mode: 'text', prompt: 'x', yes: true },
      io: t
    }),
    0
  )
  assert.equal(engine.calls.find((c) => c[0] === 'resolveApproval')[1].approved, true)
  assert.equal(t.err.length, 0)
  assert.equal(t.text, 'ran it\n')
})

test('json mode writes session, deduped chunks, approval and end events', async () => {
  const engine = fakeEngine({ script: { sendMessage: asking, approved: after('approved') } })
  const t = io()
  assert.equal(
    await runPrint(engine, {
      deviceId: 'aa',
      options: { mode: 'json', prompt: 'x', yes: true },
      io: t
    }),
    0
  )
  const events = t.events
  assert.deepEqual(events[0], {
    type: 'session',
    chatId: 'chat-new-1',
    meshId: 'account',
    runId: 'run-1',
    model: 'quack'
  })
  assert.equal(events.at(-1).type, 'end')
  assert.equal(events.at(-1).status, 'completed')
  assert.equal(events.at(-1).reason, null)
  const ids = events.filter((e) => e.type === 'chunk').map((e) => e.chunk.id)
  assert.deepEqual(ids, ['chunk-0', 'chunk-1', 'chunk-1', 'chunk-2', 'chunk-3'])
  assert.equal(events.find((e) => e.type === 'approval').approved, true)
})

test('--continue appends to the remembered chat and skips its old chunks', async () => {
  const old = [
    user(0, 'before'),
    content(1, 'old answer', 'run-0'),
    status(2, 'completed', { runId: 'run-0' })
  ]
  const engine = fakeEngine({
    existing: old,
    script: {
      sendMessage: [
        [
          ...old,
          user(3, 'again'),
          content(4, 'new', 'run-1'),
          status(5, 'completed', { runId: 'run-1' })
        ]
      ]
    }
  })
  const t = io()
  assert.equal(
    await runPrint(engine, {
      deviceId: 'aa',
      options: { mode: 'json', prompt: 'again', continue: true },
      io: t
    }),
    0
  )
  assert.deepEqual(engine.calls.find((c) => c[0] === 'sendMessage')[1], {
    meshId: 'account',
    chatId: 'chat-1',
    text: 'again'
  })
  const ids = t.events.filter((e) => e.type === 'chunk').map((e) => e.chunk.id)
  assert.deepEqual(ids, ['chunk-3', 'chunk-4', 'chunk-5'])
})

test('--model switches the agent before sending', async () => {
  const engine = fakeEngine({ script: { sendMessage: answer } })
  await runPrint(engine, {
    deviceId: 'aa',
    options: { mode: 'text', prompt: 'x', model: 'big' },
    io: io()
  })
  assert.deepEqual(engine.calls.find((c) => c[0] === 'updateAgent')[1], {
    meshId: 'account',
    agentId: 'agent-1',
    config: { modelName: 'big' }
  })
})

function rpcInput() {
  const f = feed()
  return {
    send: (command) =>
      f.push(typeof command === 'string' ? command + '\n' : JSON.stringify(command) + '\n'),
    end: () => f[Symbol.asyncIterator]().return(),
    stream: { [Symbol.asyncIterator]: () => f[Symbol.asyncIterator]() }
  }
}

const tick = (n = 10) =>
  (async () => {
    for (let i = 0; i < n; i++) {
      await new Promise((r) => setImmediate(r))
    }
  })()

test('rpc answers commands and streams chunk and end events', async () => {
  const engine = fakeEngine({ script: { sendMessage: answer } })
  const input = rpcInput()
  const t = io(input.stream)
  const done = runPrint(engine, { deviceId: 'aa', options: { mode: 'rpc' }, io: t })
  input.send({ id: 1, type: 'get_state' })
  await tick()
  input.send({ id: 2, type: 'prompt', text: 'hi' })
  await tick(30)
  input.send({ id: 3, type: 'get_messages' })
  input.send({ id: 4, type: 'set_model', model: 'big' })
  input.send({ id: 5, type: 'get_available_models' })
  input.send({ id: 6, type: 'nope' })
  input.send({ id: 7, type: 'new_session' })
  input.send({ id: 8, type: 'get_state' })
  await tick()
  input.end()
  assert.equal(await done, 0)
  const events = t.events
  const response = (id) => events.find((e) => e.type === 'response' && e.id === id)
  assert.deepEqual(response(1).data, {
    chatId: null,
    meshId: 'account',
    agentId: 'agent-1',
    model: 'quack',
    running: false
  })
  assert.deepEqual(response(2).data, { chatId: 'chat-new-1', runId: 'run-1' })
  assert.equal(events.filter((e) => e.type === 'chunk').length, 5)
  assert.deepEqual(
    events.find((e) => e.type === 'end'),
    { type: 'end', runId: 'run-1', status: 'completed', reason: null }
  )
  assert.deepEqual(
    response(3).data.messages.map((m) => m.from),
    ['user', 'agent']
  )
  assert.equal(response(3).data.messages[1].segments[0].text, 'Hello')
  assert.deepEqual(response(4).data, { model: 'big' })
  assert.deepEqual(
    response(5).data.models.map((m) => m.name),
    ['quack']
  )
  assert.deepEqual(engine.calls.find((c) => c[0] === 'listModels')[1], { cachedOnly: true })
  assert.equal(response(6).ok, false)
  assert.match(response(6).error, /unknown command/)
  assert.equal(response(8).data.chatId, null)
})

test('rpc abort stops the active run, approve resolves, and closing stdin waits for the run', async () => {
  const engine = fakeEngine({ script: { sendMessage: asking, denied: after('denied') } })
  const input = rpcInput()
  const t = io(input.stream)
  const done = runPrint(engine, { deviceId: 'aa', options: { mode: 'rpc' }, io: t })
  input.send({ id: 1, type: 'prompt', text: 'hi' })
  await tick(30)
  input.send({ id: 2, type: 'abort' })
  input.send({ id: 3, type: 'approve', chunkId: 'chunk-1', approved: false })
  input.send('not json')
  input.end()
  assert.equal(await done, 0)
  const events = t.events
  assert.deepEqual(
    events.find((e) => e.type === 'approval'),
    {
      type: 'approval',
      chunkId: 'chunk-1',
      name: 'bash',
      arguments: { cmd: 'ls' },
      agentId: 'agent-1'
    }
  )
  assert.deepEqual(engine.calls.find((c) => c[0] === 'stopRun')[1], {
    meshId: 'account',
    chatId: 'chat-new-1',
    runId: 'run-1'
  })
  assert.deepEqual(engine.calls.find((c) => c[0] === 'resolveApproval')[1], {
    meshId: 'account',
    chunkId: 'chunk-1',
    approved: false,
    scope: 'once',
    agentId: 'agent-1'
  })
  assert.equal(events.find((e) => e.type === 'response' && e.error === 'invalid JSON').ok, false)
  assert.equal(events.at(-1).type, 'end')
})
