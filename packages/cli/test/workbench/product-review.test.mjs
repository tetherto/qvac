import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { cellWidth } from '../../dist/product/text.js'
import { loadConfig } from '../../dist/lib/runtime/config.js'
import { App, boot, chunk, fakeEngine, model, press, screen, settle, type } from './helpers/app.mjs'

test('boot resolves the remembered chat and streams its transcript natively', async () => {
  const { app, engine } = await boot()
  assert.equal(app.chatId, 'chat-1')
  engine.watches['chunks:chat-1'].push({
    chunks: [
      chunk(0, 'user-message', { userMessage: { text: 'Hello' } }),
      chunk(1, 'content', { content: { text: '# Hi there' } }),
      chunk(2, 'run-status', { runStatus: { state: 'completed' } })
    ]
  })
  await settle(app)
  const view = screen(app)
  assert.match(view, /❯ Hello/)
  assert.match(view, /◆ QV\.AC/)
  assert.match(view, /Hi there/)
  assert.match(view, /Model {6}/)
  assert.ok((view.match(/Online/g) || []).length <= 1, 'the brand line alone shows the status')
  assert.match(view, /CHAT/)
})

test('the dashboard keeps a composer and enter or slash jumps into chat', async () => {
  const { app } = await boot({ startPage: 'overview' })
  assert.match(screen(app), /enter to chat/)
  press(app, 'return')
  assert.equal(app.page, 'chat')
  app.page = 'overview'
  press(app, '/', { sequence: '/' })
  assert.equal(app.page, 'chat')
  assert.equal(app.editor.value, '/')
  assert.match(screen(app), /\/new\s+Start a fresh conversation/)
})

test('a new conversation is minted by the first send with the agent and a title', async () => {
  const { app, engine } = await boot()
  press(app, 'n', { ctrl: true, sequence: '\x0e' })
  assert.equal(app.chatId, null)
  type(app, 'Plan a refactor')
  await settle(app, press(app, 'return'))
  assert.deepEqual(engine.calls.find((c) => c[0] === 'sendMessage')[1], {
    meshId: 'account',
    agentId: 'agent-1',
    text: 'Plan a refactor',
    title: 'Plan a refactor'
  })
  assert.equal(app.chatId, 'chat-new')
  assert.equal(app.editor.value, '')
})

test('a refused send puts the draft back in the composer', async () => {
  const { app } = await boot({
    engine: {
      sendMessage: () => Promise.reject(new Error('Core is closing'))
    }
  })
  type(app, 'keep me')
  await settle(app, press(app, 'return'))
  assert.equal(app.editor.value, 'keep me')
  assert.match(screen(app), /Not sent: Core is closing/)
})

test('approvals answer with y, a or n and lock the composer meanwhile', async () => {
  const { app, engine } = await boot()
  engine.watches['chunks:chat-1'].push({
    chunks: [
      chunk(0, 'run-request'),
      chunk(1, 'approval-request', {
        approvalRequest: {
          status: 'pending',
          name: 'exec',
          arguments: { command: 'ls' },
          resource: { kind: 'folder', label: '/tmp/project' },
          agentId: 'agent-1'
        }
      })
    ]
  })
  await settle(app)
  assert.match(screen(app), /Approval needed/)
  assert.match(screen(app), /\/tmp\/project/)
  assert.match(screen(app), /\$ ls/)
  press(app, 'x')
  assert.equal(app.editor.value, '')
  await settle(app, press(app, 'a'))
  assert.deepEqual(engine.calls.find((c) => c[0] === 'resolveApproval')[1], {
    meshId: 'account',
    chunkId: 'chunk-1',
    approved: true,
    scope: 'always',
    agentId: 'agent-1'
  })
})

test('escape stops the active run and context-limit warnings stay visible', async () => {
  const { app, engine } = await boot()
  engine.watches['chunks:chat-1'].push({
    chunks: [
      chunk(0, 'run-request', { runId: 'run-0' }),
      chunk(1, 'content', { content: { text: 'Partial' }, runId: 'run-0' }),
      chunk(2, 'run-status', {
        runStatus: { state: 'completed', metrics: { stopReason: 'length' } },
        runId: 'run-0'
      }),
      chunk(3, 'run-request'),
      chunk(4, 'content', { content: { text: 'Working on it' } })
    ]
  })
  await settle(app)
  assert.match(screen(app), /Context limit reached/)
  await settle(app, press(app, 'escape'))
  assert.deepEqual(engine.calls.find((c) => c[0] === 'stopRun')[1], {
    meshId: 'account',
    chatId: 'chat-1',
    runId: 'run-1'
  })
})

test('bracketed paste is data: it never submits, runs commands or switches pages', async () => {
  const { app, engine } = await boot()
  press(app, 'paste-start')
  type(app, '/quit')
  press(app, 'return')
  press(app, 'g', { ctrl: true, sequence: '\x07' })
  press(app, 'paste-end')
  assert.equal(app.page, 'chat')
  assert.equal(app.editor.value, '/quit\n')
  assert.equal(
    engine.calls.some((c) => c[0] === 'sendMessage'),
    false
  )
})

test('the chat picker switches conversations and the model picker updates the agent', async () => {
  const { app, engine } = await boot()
  app.chats.push({ id: 'chat-2', title: 'Second' })
  press(app, 'b', { ctrl: true, sequence: '\x02' })
  assert.match(screen(app), /Conversations/)
  type(app, 'Sec')
  await settle(app, press(app, 'return'))
  assert.equal(app.chatId, 'chat-2')
  type(app, '/model')
  await settle(app, press(app, 'return'))
  assert.match(screen(app), /Chat model/)
  await settle(app, press(app, 'return'))
  assert.equal(engine.calls.find((c) => c[0] === 'updateAgent')[1].config.modelName, 'Local')
})

test('frames fit the terminal at every size, with a long multiline draft', async () => {
  for (const [width, height] of [
    [32, 16],
    [80, 24],
    [140, 50]
  ]) {
    const { app } = await boot({ width, height })
    app.editor.set('A'.repeat(width * 3) + '\nsecond line')
    for (const page of ['chat', 'overview', 'device', 'models']) {
      app.page = page
      const rows = screen(app).split('\n')
      assert.equal(rows.length, height, `${page} ${width}x${height}`)
      assert.ok(
        rows.every((r) => cellWidth(r) <= width),
        `${page} ${width}x${height}`
      )
    }
  }
})

test('non-chat models cannot replace the chat model from the Models page', async () => {
  const { app, engine } = await boot({ startPage: 'models' })
  app.product.models = [model('Whisper', { taskType: 'speech-to-text' })]
  press(app, 'return')
  assert.equal(app.page, 'models')
  assert.match(app.error, /not a chat model/i)
  assert.equal(
    engine.calls.some((c) => c[0] === 'updateAgent'),
    false
  )
})

test('loaded model removal is refused even after the confirmation screen opens', async () => {
  let removed = false
  const { app } = await boot({
    engine: {
      deleteModel: () => {
        removed = true
        return Promise.resolve()
      }
    }
  })
  app.page = 'remove'
  app.removeName = 'Local'
  app.product.models = [model('Local', { isLoaded: true })]
  await settle(app, press(app, 'y'))
  assert.equal(removed, false)
  assert.match(screen(app), /Unload this model/)
})

test('the mouse wheel scrolls the transcript and a drag copies the selected text', async () => {
  const copied = []
  const { app, engine } = await boot({
    copyToClipboard: (text) => {
      copied.push(text)
      return Promise.resolve()
    }
  })
  engine.watches['chunks:chat-1'].push({
    chunks: Array.from({ length: 60 }, (_, i) =>
      chunk(i, 'user-message', { userMessage: { text: `line ${i}` } })
    )
  })
  await settle(app)
  assert.match(screen(app), /line 59/)
  app.update({ type: 'mouse', action: 'wheel', button: 'wheelup', x: 0, y: 0 })
  assert.equal(app.scroll, 3)
  assert.doesNotMatch(screen(app), /line 59/)
  app.update({ type: 'mouse', action: 'wheel', button: 'wheeldown', x: 0, y: 0 })
  assert.equal(app.scroll, 0)
  assert.doesNotMatch(screen(app), /Model {6}/, 'the banner scrolls away with the transcript')
  const rows = screen(app).split('\n'),
    y = rows.findIndex((r) => r.includes('QV.AC'))
  app.update({ type: 'mouse', action: 'press', button: 'left', x: 0, y })
  app.update({ type: 'mouse', action: 'motion', button: 'left', x: 40, y })
  assert.match(app.view(), /\x1b\[7m/)
  await settle(app, app.update({ type: 'mouse', action: 'release', button: 'left', x: 40, y })[1])
  assert.match(copied[0], /^QV\.AC\s+Personal/)
})

test('typing @ offers fuzzy project files and tab completes the reference', async () => {
  const { app, engine } = await boot({
    listFiles: () => [
      'README.md',
      'src/product/app.mjs',
      'src/product/theme.mjs',
      'test/app.test.mjs'
    ]
  })
  type(app, 'look at @prodapp')
  assert.match(screen(app), /@src\/product\/app\.mjs/)
  assert.doesNotMatch(screen(app), /README/)
  press(app, 'tab')
  assert.equal(app.editor.value, 'look at @src/product/app.mjs ')
  await settle(app, press(app, 'return'))
  assert.equal(
    engine.calls.find((c) => c[0] === 'sendMessage')[1].text,
    'look at src/product/app.mjs '
  )
})

test('a message sent while Core is still starting is queued and sent once the chat is ready', async () => {
  const engine = fakeEngine()
  const app = new App({ engine, deviceId: 'aa', skipSetup: true })
  app.width = 100
  app.height = 34
  type(app, 'early bird')
  press(app, 'return')
  assert.equal(app.editor.value, '')
  assert.match(app.notice, /Queued/)
  await settle(app, app.init())
  assert.equal(engine.calls.find((c) => c[0] === 'sendMessage')[1].text, 'early bird')
})

test('esc always leads back to chat, and pages are 1–3 once the composer is left', async () => {
  const { app } = await boot({ startPage: 'device' })
  press(app, 'escape')
  assert.equal(app.page, 'chat')
  press(app, '2')
  assert.equal(app.editor.value, '2')
  app.editor.reset()
  press(app, 'escape')
  assert.equal(app.composing, false)
  press(app, '2')
  assert.equal(app.page, 'device')
  press(app, 'escape')
  press(app, '3', { meta: true })
  assert.equal(app.page, 'models')
  press(app, 'escape')
  assert.equal(app.page, 'chat')
  assert.equal(app.composing, true)
})

test('"/" from inside a menu closes it and starts a command; /model reaches every model', async () => {
  const { app } = await boot()
  press(app, 'b', { ctrl: true, sequence: '\x02' })
  assert.ok(app.picker)
  press(app, '/', { sequence: '/' })
  assert.equal(app.picker, null)
  assert.equal(app.editor.value, '/')
  app.editor.reset()
  type(app, '/model')
  press(app, 'return')
  assert.match(screen(app), /All models…/)
  type(app, 'All')
  press(app, 'return')
  assert.equal(app.page, 'models')
})

test('a failed tool says why once, and a run that ends without an answer says so', async () => {
  const { app, engine } = await boot()
  engine.watches['chunks:chat-1'].push({
    chunks: [
      chunk(0, 'run-request'),
      chunk(1, 'tool-call', {
        toolCall: { name: 'edit_file', arguments: { path: 'a', old: '', new: 'x' } }
      }),
      chunk(2, 'tool-result', {
        toolResult: { name: 'edit_file', result: { error: 'old must be the text to replace' } }
      }),
      chunk(3, 'run-status', { runStatus: { state: 'completed' } })
    ]
  })
  await settle(app)
  const view = screen(app)
  assert.equal(view.split('old must be the text to replace').length - 1, 1)
  assert.match(view, /Ended without an answer/)
})

test('a running delegation shows each task in the transcript', async () => {
  const { app, engine } = await boot()
  engine.watches['chunks:chat-1'].push({
    chunks: [
      chunk(0, 'run-request'),
      chunk(1, 'tool-call', {
        toolCall: { name: 'delegate', arguments: { tasks: ['Review a.mjs', 'Review b.mjs'] } }
      })
    ]
  })
  await settle(app)
  const view = screen(app)
  assert.match(view, /Delegate 2 tasks\s+2 running/)
  assert.match(view, /◌ Review a\.mjs/)
  assert.match(view, /◌ Review b\.mjs/)
})

test('config keeps SDK plugin semantics and resolves host paths against its source', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qvac-review-config-'))
  try {
    fs.writeFileSync(
      path.join(dir, 'qvac.config.json'),
      JSON.stringify({
        plugins: ['sdk-plugin'],
        core: { folders: ['./project'] },
        harness: { plugins: [{ use: './host-plugin.mjs' }] }
      })
    )
    fs.writeFileSync(path.join(dir, 'qvac.config.js'), 'throw new Error("JSON discovery must win")')
    const { config, configPath } = await loadConfig({ cwd: dir })
    assert.equal(configPath, path.join(dir, 'qvac.config.json'))
    assert.deepEqual(config.plugins, ['sdk-plugin'])
    assert.deepEqual(config.core.folders, [{ path: path.join(dir, 'project'), write: false }])
    assert.equal(config.harness.plugins[0].module, path.join(dir, 'host-plugin.mjs'))
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('config rejects colliding external target identities before host boot', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qvac-review-config-'))
  try {
    const target = { name: 'reviewer', protocol: 'codex', command: 'codex' }
    fs.writeFileSync(
      path.join(dir, 'qvac.config.json'),
      JSON.stringify({ harness: { delegation: { targets: [target, target] } } })
    )
    await assert.rejects(() => loadConfig({ cwd: dir }), /unique name/)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('configured npm plugins may expose an ESM-only import entry', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qvac-esm-plugin-review-'))
  try {
    const plugin = path.join(dir, 'node_modules', 'review-plugin')
    fs.mkdirSync(plugin, { recursive: true })
    fs.writeFileSync(
      path.join(plugin, 'package.json'),
      JSON.stringify({ name: 'review-plugin', type: 'module', exports: { import: './index.mjs' } })
    )
    fs.writeFileSync(
      path.join(plugin, 'index.mjs'),
      'throw new Error("resolution must not execute plugin code")'
    )
    fs.writeFileSync(
      path.join(dir, 'qvac.config.json'),
      JSON.stringify({ harness: { plugins: ['review-plugin'] } })
    )
    const loaded = await loadConfig({ cwd: dir })
    assert.equal(
      fs.realpathSync(loaded.config.harness.plugins[0].module),
      fs.realpathSync(path.join(plugin, 'index.mjs'))
    )
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('chat footer rows fit at 60, 80 and 100 columns without wrapping', async () => {
  for (const width of [60, 80, 100]) {
    const { app } = await boot({
      width,
      height: 30,
      deviceName: 'an-extraordinarily-long-workstation-device-name',
      home: '/Users/someone',
      cwd: '/Users/someone/projects/deeply/nested/folder/structure/for/the/app'
    })
    app.agent = { ...app.agent, modelName: 'Qwen3.5-35B-A3B-Instruct-Thinking-Q4_K_M-imat' }
    const rows = screen(app).split('\n')
    assert.equal(rows.length, 30, `rows at ${width}`)
    assert.ok(
      rows.every((r) => cellWidth(r) <= width),
      `width ${width}`
    )
    const tabs = rows.findIndex((r) => r.includes('▸ Chat'))
    assert.equal(tabs, rows.length - 1, `tab row is last at ${width}`)
    assert.match(rows[tabs - 1], /Ready/, `status row sits above the tabs at ${width}`)
    assert.doesNotMatch(rows.at(-1), /ctrl\+g dashboard/)
  }
})

test('thinking collapses once later steps follow and the live turn shows what runs now', async () => {
  const { app, engine } = await boot()
  engine.watches['chunks:chat-1'].push({
    chunks: [
      chunk(0, 'run-request'),
      chunk(1, 'thinking', { thinking: { text: 'Let me look at the tests first.' } })
    ]
  })
  await settle(app)
  assert.match(screen(app), /Thinking… \d+s/)
  assert.equal(screen(app).match(/Thinking|Working/g).length, 1, 'the run state shows once, inline')
  engine.watches['chunks:chat-1'].push({
    chunks: [
      chunk(0, 'run-request'),
      chunk(1, 'thinking', { thinking: { text: 'Let me look at the tests first.' } }),
      chunk(2, 'tool-call', {
        toolCall: { name: 'exec', arguments: { command: 'npm test' } }
      })
    ]
  })
  await settle(app)
  const view = screen(app)
  assert.match(view, /✓ Thought · 31 chars/)
  assert.match(view, /Running exec npm test…/)
})

test('the answer is set apart from the steps before it by one blank line', async () => {
  const { app, engine } = await boot()
  engine.watches['chunks:chat-1'].push({
    chunks: [
      chunk(0, 'run-request'),
      chunk(1, 'thinking', { thinking: { text: 'Restore the file.' } }),
      chunk(2, 'content', { content: { text: '\n\n' } }),
      chunk(3, 'content', { content: { text: 'Done, the file is back.' } })
    ]
  })
  await settle(app)
  const rows = screen(app)
    .split('\n')
    .map((r) => r.trim())
  const answer = rows.findIndex((r) => r.startsWith('Done, the file is back.'))
  assert.match(rows[answer - 2], /✓ Thought · 17 chars/)
  assert.equal(rows[answer - 1], '')
})

test("Core's suggested next message is the placeholder, tab takes it, and a newer turn drops it", async () => {
  const { app, engine } = await boot()
  const answered = [
    chunk(0, 'user-message', { runId: null, userMessage: { text: 'What goes in .gitignore?' } }),
    chunk(1, 'run-request'),
    chunk(2, 'content', { content: { text: 'node_modules/ and dist/.' } }),
    chunk(3, 'run-status', { runStatus: { state: 'completed' } })
  ]
  engine.watches['chunks:chat-1'].push({ chunks: answered })
  engine.watches.chats.push({
    chats: [
      {
        id: 'chat-1',
        title: 'Gitignore',
        suggestion: { text: 'Update my .gitignore to match', runId: 'run-1' }
      }
    ]
  })
  await settle(app)
  assert.match(screen(app), /Update my \.gitignore to match · tab to use/)

  press(app, 'tab')
  assert.equal(app.editor.value, 'Update my .gitignore to match')

  app.editor.set('')
  engine.watches['chunks:chat-1'].push({
    chunks: [
      ...answered,
      chunk(4, 'user-message', { runId: null, userMessage: { text: 'thanks' } })
    ]
  })
  await settle(app)
  assert.doesNotMatch(screen(app), /tab to use/, 'a suggestion for an earlier run is not offered')
})

test('a short terminal shows the brand line once, not again atop the transcript', async () => {
  const { app } = await boot({ height: 22 })
  assert.equal(screen(app).match(/QV\.AC {2}Personal/g).length, 1)
})

test('context use is a right-aligned bar with tokens used of the window', async () => {
  const { app, engine } = await boot({ width: 120 })
  engine.watches['chunks:chat-1'].push({
    chunks: [
      chunk(0, 'run-request'),
      chunk(1, 'content', { content: { text: 'Done.' } }),
      chunk(2, 'run-status', {
        runStatus: { state: 'completed', metrics: { ctxSize: 51200, totalTokens: 5120 } }
      })
    ]
  })
  await settle(app)
  const row = screen(app)
    .split('\n')
    .find((r) => r.includes('context '))
  assert.match(row, /context ━+ 5\.1k of 51k {3}\/ commands {2}ctrl\+b chats\s*$/)
  assert.equal(row.match(/━/g).length, 12)
  assert.doesNotMatch(screen(app), /ctx \d+%/)
})

test('a message sent mid-run waits under the running turn without a second spinner', async () => {
  const { app, engine } = await boot()
  engine.watches['chunks:chat-1'].push({
    chunks: [
      chunk(0, 'user-message', { runId: null, userMessage: { text: 'first' } }),
      chunk(1, 'run-request'),
      chunk(2, 'thinking', { thinking: { text: 'hmm' } }),
      chunk(3, 'user-message', { runId: null, userMessage: { text: 'also check the tests' } }),
      chunk(4, 'run-request', { runId: 'run-2' })
    ]
  })
  await settle(app)
  const view = screen(app)
  assert.match(view, /↳ waiting: the running turn reads this at its next step/)
  assert.equal(view.match(/◆ QV\.AC/g).length, 1)
  assert.doesNotMatch(view, /Working · \d+s/)
})

test('esc with a message waiting stops the running turn, so the waiting one goes next', async () => {
  const { app, engine } = await boot()
  engine.watches['chunks:chat-1'].push({
    chunks: [
      chunk(0, 'user-message', { runId: null, userMessage: { text: 'first' } }),
      chunk(1, 'run-request'),
      chunk(2, 'thinking', { thinking: { text: 'hmm' } }),
      chunk(3, 'user-message', { runId: null, userMessage: { text: 'also check the tests' } }),
      chunk(4, 'run-request', { runId: 'run-2' })
    ]
  })
  await settle(app)
  await settle(app, press(app, 'escape'))
  const stopped = engine.calls.filter((c) => c[0] === 'stopRun').map((c) => c[1].runId)
  assert.deepEqual(stopped, ['run-1'])
})

test('a message steered into the running turn shows as answered there, not as a turn of its own', async () => {
  const { app, engine } = await boot()
  engine.watches['chunks:chat-1'].push({
    chunks: [
      chunk(0, 'user-message', { runId: null, userMessage: { text: 'first' } }),
      chunk(1, 'run-request'),
      chunk(2, 'user-message', { runId: null, userMessage: { text: 'also check the tests' } }),
      chunk(3, 'run-request', { runId: 'run-2' }),
      chunk(4, 'content', { content: { text: 'Done, tests included.' } }),
      chunk(5, 'run-status', { runStatus: { state: 'completed' } }),
      chunk(6, 'run-status', {
        runId: 'run-2',
        runStatus: { state: 'completed', reason: 'steered', metrics: { steeredInto: 'run-1' } }
      })
    ]
  })
  await settle(app)
  const view = screen(app)
  assert.match(view, /↳ answered in the turn above/)
  assert.doesNotMatch(view, /Ended without an answer/)
})
