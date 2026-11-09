import test from 'node:test'
import assert from 'node:assert/strict'
import { boot, model, press, screen, settle } from './helpers/app.mjs'

test('qvac boots onto the overview, with the pages as tabs and no chat', async () => {
  const { app } = await boot()
  assert.equal(app.page, 'overview')
  const text = screen(app)
  assert.match(text, /Your workspace, at a glance/)
  assert.match(text, /▸ 1 Overview\s+2 Device\s+3 Models/)
  assert.doesNotMatch(text, /Chat|enter to chat|Ask QV\.AC/)
  assert.match(text, /v all devices.*w workspace.*s status/)
})

test('pages are 1–3 and alt+1–3, tab goes round them, and esc leads home', async () => {
  const { app } = await boot()
  press(app, '2')
  assert.equal(app.page, 'device')
  press(app, '3', { meta: true })
  assert.equal(app.page, 'models')
  press(app, 'tab')
  assert.equal(app.page, 'overview')
  press(app, 'escape')
  assert.equal(app.page, 'overview')
  press(app, 'return')
  assert.equal(app.page, 'overview')
})

test('the management pages open from anywhere: devices, workspaces, status, help', async () => {
  const { app } = await boot({ startPage: 'models' })
  press(app, 'v')
  assert.equal(app.page, 'devices')
  assert.match(screen(app), /Together, more capable/)
  press(app, 'w')
  assert.equal(app.page, 'workspaces')
  assert.match(screen(app), /Choose your workspace/)
  press(app, 's')
  assert.equal(app.page, 'status')
  assert.match(screen(app), /This device, right now/)
  press(app, '?', { sequence: '?' })
  assert.equal(app.page, 'help')
  assert.match(screen(app), /invite · devices · workspaces · status/)
  press(app, 'escape')
  assert.equal(app.page, 'overview')
})

test('a model is loaded or unloaded from the Models page, never chosen for a chat', async () => {
  const { app, engine } = await boot({
    startPage: 'models',
    engine: { loadModel: () => Promise.resolve({ loaded: true }) }
  })
  assert.doesNotMatch(screen(app), /chat with it/)
  press(app, 'return')
  assert.equal(app.page, 'models')
  assert.equal(app.error, '')
  app.product.models = [model('Whisper', { taskType: 'speech-to-text' })]
  press(app, 'return')
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

test('frames fit the terminal at every size on every page', async () => {
  const { app } = await boot()
  for (const [width, height] of [
    [60, 16],
    [80, 24],
    [120, 40]
  ]) {
    app.width = width
    app.height = height
    for (const page of [
      'overview',
      'device',
      'models',
      'devices',
      'workspaces',
      'status',
      'help'
    ]) {
      app.page = page
      const rows = screen(app).split('\n')
      assert.equal(rows.length, height, `${page} at ${width}x${height}`)
      for (const row of rows) {
        assert.ok(app.measure(row) <= width, `${page} at ${width}x${height}: ${row}`)
      }
    }
  }
})
