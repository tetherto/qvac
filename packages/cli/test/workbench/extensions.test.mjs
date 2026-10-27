import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { loadExtensions } from '../../dist/product/extension-loader.js'
import { plain, palette } from '../../dist/product/theme.js'
import { App, fakeEngine, press, screen, settle, type } from './helpers/app.mjs'

test('an extension command is in the palette and /help, and its string reply shows', async () => {
  const { app } = await boot([
    { name: 'clock', commands: [{ name: 'time', description: 'Tell the time', run: () => 'noon' }] }
  ])

  type(app, '/ti')
  assert.match(screen(app), /\/time\s+Tell the time · clock/)

  await settle(app, press(app, 'return'))
  assert.equal(app.notice, 'noon')

  await settle(app, app.command('/help'))
  assert.ok(app.panel.lines.some((l) => /\/time.*Tell the time/.test(plain(l))))
})

test('ctx sends, inserts, notices and shows through the app, async included', async () => {
  const seen = []
  const { app, engine } = await boot([
    {
      name: 'kit',
      commands: [
        {
          name: 'kit',
          run: async (ctx, args) => {
            seen.push({ model: ctx.model, chatId: ctx.chatId, cwd: ctx.cwd, args })
            await Promise.resolve()
            ctx.insert('drafted')
            ctx.show('Kit', ['one', 'two'])
            ctx.send('from an extension')
          }
        }
      ]
    }
  ])

  await settle(app, app.command('/kit go'))
  assert.deepEqual(seen, [{ model: 'Local', chatId: 'chat-1', cwd: '/work', args: 'go' }])
  assert.equal(app.editor.value, 'drafted')
  assert.deepEqual(app.panel, { title: 'Kit', lines: ['one', 'two'] })
  assert.equal(engine.calls.find((c) => c[0] === 'sendMessage')[1].text, 'from an extension')
})

test('a throwing command or footer becomes a notice naming the extension', async () => {
  const { app } = await boot([
    {
      name: 'broken',
      commands: [
        {
          name: 'boom',
          run: () => {
            throw new Error('kaboom')
          }
        }
      ]
    }
  ])
  await settle(app, app.command('/boom'))
  assert.equal(app.notice, 'Extension broken failed: kaboom')

  const { app: other } = await boot([
    {
      name: 'flaky',
      footer: () => {
        throw new Error('no clock')
      }
    }
  ])
  screen(other)
  await settle(other)
  assert.match(screen(other), /Extension flaky failed: no clock/)
})

test('footer text sits on the right when wide, and gives way to the core hints when narrow', async () => {
  const extension = { name: 'clock', footer: () => '12:34' }
  const { app } = await boot([extension])
  assert.match(screen(app), /12:34\s+\/ commands {2}ctrl\+b chats/)

  const { app: narrow } = await boot([extension], { width: 60 })
  assert.doesNotMatch(screen(narrow), /12:34/)
  assert.match(screen(narrow), /\/ commands/)
})

test('extension keys work in the composer; built-in keys and taken commands are refused once', async () => {
  const pressed = []
  const { app } = await boot([
    {
      name: 'keys',
      keys: {
        'alt+t': (ctx) => ctx.insert('T'),
        'ctrl+b': () => pressed.push('stolen'),
        'ctrl+k': () => pressed.push('stolen')
      },
      commands: [{ name: 'new', run: () => pressed.push('stolen') }]
    }
  ])

  assert.equal(
    app.notice,
    'Extension keys: /new is already taken · Extension keys: ctrl+b is already bound · Extension keys: ctrl+k is already bound'
  )

  await settle(app, press(app, 't', { meta: true }))
  assert.equal(app.editor.value, 'T')

  await settle(app, press(app, 'k', { ctrl: true }))
  await settle(app, app.command('/new'))
  assert.deepEqual(pressed, [])
})

test('theme reshades existing tokens and ignores unknown ones', async () => {
  const before = { ...palette }
  const { app } = await boot([{ name: 'shade', theme: { teal: '#20c0a0', neon: '#ffffff' } }])

  assert.equal(palette.teal, '32;192;160')
  assert.equal(palette.neon, undefined)
  assert.equal(app.notice, 'Extension shade: theme neon ignored')
  assert.match(plain(app.view()), /QV\.AC/)
  Object.assign(palette, before)
})

test('the loader takes inline entries from the config file, use paths and plain objects', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qvac-extensions-'))
  const configPath = path.join(dir, 'qvac.config.mjs')
  fs.mkdirSync(path.join(dir, 'ui'))
  fs.writeFileSync(
    configPath,
    "export default { tui: { extensions: ['./ui/x.mjs', { name: 'inline', footer: () => 'hi' }] } }\n"
  )
  fs.writeFileSync(
    path.join(dir, 'ui', 'x.mjs'),
    "export default (options) => ({ name: 'x', footer: () => options.label })\n"
  )
  fs.writeFileSync(path.join(dir, 'ui', 'bad.mjs'), "throw new Error('nope')\n")

  const { extensions, problems } = await loadExtensions(
    [
      { inline: 1, name: 'inline' },
      { use: './ui/x.mjs', options: { label: 'X' } },
      { name: 'json', theme: { teal: '1;2;3' } },
      './ui/bad.mjs'
    ],
    {
      configPath,
      load: (file) => import(pathToFileURL(path.resolve(dir, file)).href)
    }
  )

  assert.deepEqual(
    extensions.map((p) => p.name),
    ['inline', 'x', 'json']
  )
  assert.equal(extensions[0].extension.footer(), 'hi')
  assert.equal(extensions[1].extension.footer(), 'X')
  assert.deepEqual(problems, ['Extension ./ui/bad.mjs did not load: nope'])
  fs.rmSync(dir, { recursive: true })
})

async function boot(extensions, { width = 100, height = 34 } = {}) {
  const engine = fakeEngine()
  const app = new App({
    engine,
    deviceId: 'aa',
    skipSetup: true,
    cwd: '/work',
    extensions: {
      extensions: extensions.map((extension) => ({ name: extension.name, extension })),
      problems: []
    },
    post: (msg) => settle(app, app.update(msg)[1])
  })
  app.width = width
  app.height = height
  await settle(app, app.init())

  return { app, engine }
}

test('a reload swaps in the new extensions at once, and names plugin changes', async () => {
  const { app } = await boot([])
  const hi = {
    name: 'hi',
    commands: [{ name: 'hi', description: 'Say hello', run: () => 'Hello!' }]
  }

  app.update({
    type: 'extensions.reloaded',
    loaded: { extensions: [{ name: 'hi', extension: hi }], problems: [] },
    pluginsChanged: true
  })
  assert.match(app.notice, /^qvac\.config reloaded · plugins changed: \/plugins, then r/)

  await settle(app, app.command('/hi'))
  assert.equal(app.notice, 'Hello!')
})
