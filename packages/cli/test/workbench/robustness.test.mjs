// What the chaos run found, pinned so each stays fixed.
import assert from 'node:assert/strict'
import test from 'node:test'
import { renderApprovalPreview, renderToolBody, toolSummary } from '../../dist/product/tool-view.js'
import { canvas, plain } from '../../dist/product/theme.js'
import { cellWidth } from '../../dist/product/text.js'
import { App, KeyMsg, boot, chunk, fakeEngine, press, screen, settle } from './helpers/app.mjs'

const leaks = (rows) => rows.map(plain).filter((r) => /undefined|NaN|\[object Object\]/.test(r))

test('a tool call with missing or odd arguments reads as missing, never as undefined', () => {
  assert.equal(toolSummary({ name: 'read_file', args: {} }).title, 'Read (no path)')
  assert.equal(
    toolSummary({ name: 'move_file', args: { from: 3 } }).title,
    'Move (no source) → (no target)'
  )
  assert.equal(toolSummary({ name: 'list_dir', args: { path: { x: 1 } } }).title, 'List .')
  assert.equal(toolSummary({ name: 'grep', args: { pattern: ['a'] } }).title, 'Search "["a"]"')
  assert.deepEqual(
    leaks(renderApprovalPreview({ name: 'shell', args: { command: { x: 1 } } }, { width: 60 })),
    []
  )
  assert.deepEqual(
    leaks(
      renderApprovalPreview(
        { name: 'edit_file', args: { path: 'a', old: null, new: { x: 1 } } },
        { width: 60 }
      )
    ),
    []
  )
})

test('a delegation with null tasks or results still draws', () => {
  const args = { tasks: [null, 'read it', { task: 7 }, { target: 'codex' }] }
  const result = { results: [null, { status: 'answered', text: ['odd'] }] }
  assert.equal(toolSummary({ name: 'delegate', args, result }).title, 'Delegate 4 tasks')
  assert.deepEqual(leaks(renderToolBody({ name: 'delegate', args, result }, { width: 60 })), [])
})

test('tool output and errors that are not strings are shown as data', () => {
  const rows = renderToolBody(
    { name: 'shell', args: { command: 'x' }, result: { stdout: [1, 2], stderr: { e: 1 } } },
    { width: 60 }
  )
  assert.deepEqual(leaks(rows), [])
  const failed = renderToolBody(
    { name: 'shell', args: {}, result: { error: { code: 1 } } },
    { width: 60 }
  )
  assert.match(plain(failed[0]), /"code":1/)
})

test('a row with a newline or tab stays one terminal row', () => {
  const f = canvas({ width: 40, height: 3, measure: cellWidth })
  const frame = plain(f.render(['a\nb\tc', 'next']))
  assert.equal(frame.split('\n').length, 3)
  assert.match(frame.split('\n')[0], /a b c/)
})

test('a negative context window from a peer shows no meter instead of throwing', async () => {
  const { app, engine } = await boot()
  engine.watches['chunks:chat-1'].push({
    chunks: [
      chunk(0, 'run-request'),
      chunk(1, 'run-status', {
        runStatus: { state: 'completed', metrics: { ctxSize: -100, totalTokens: 5 } }
      })
    ]
  })
  await settle(app)
  assert.doesNotMatch(screen(app), /context ━/)
})

test('page keys before the first snapshot do nothing instead of throwing', async () => {
  const engine = fakeEngine({ listMeshes: () => new Promise(() => {}) })
  const app = new App({ engine, deviceId: 'aa', skipSetup: true })
  app.width = 100
  app.height = 30
  await settle(app, app.init())
  app.page = 'models'
  assert.equal(app.product, null)
  assert.doesNotThrow(() => press(app, 'down'))
})

test('an external editor that fails leaves the draft and says why', async () => {
  const { app } = await boot({ editExternal: () => Promise.reject(new Error('no editor')) })
  app.editor.set('draft')
  await settle(app, app.update(new KeyMsg({ name: 'e', meta: true }))[1])
  assert.equal(app.editor.value, 'draft')
  assert.match(app.notice, /no editor/)
})
