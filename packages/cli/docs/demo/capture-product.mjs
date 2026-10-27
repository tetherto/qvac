// Capture actual product frames from a running Core store; never seed transcript fixtures.
import fs from 'bare-fs'
import tui from 'bare-tui'
import { bootCore } from '../../dist/lib/runtime/core-host.js'
import { productApp } from '../../dist/product/app.js'
import { screens } from '../../dist/product/screens.js'
import { hostIO } from '../../dist/lib/runtime/host-io.js'
import { listFiles } from '../../dist/lib/runtime/files.js'
import { loadTemplates, loadContextFiles } from '../../dist/lib/runtime/resources.js'

const options = JSON.parse(Bare.argv[2] || '{}')
const output = options.output || 'artifacts/screens'
const host = await bootCore({ ...options, noDefaultModels: true })
const App = productApp(tui)
const io = hostIO()
const app = new App({
  ...io,
  listFiles: () => listFiles(io.cwd),
  loadTemplates: () => loadTemplates({ cwd: io.cwd }),
  loadContext: () => loadContextFiles({ cwd: io.cwd }),
  screens,
  engine: host.engine,
  deviceId: host.deviceId,
  skipSetup: true,
  startPage: 'chat',
  ...options
})
app.width = options.width || 112
app.height = options.height || 38

// A minimal Program: run every command as bare-tui would, and read frames after settling.
let stopped = false
async function run(cmd) {
  if (!cmd || stopped) return
  if (Array.isArray(cmd)) {
    return Promise.all(cmd.map(run))
  }

  const msg = await cmd()
  if (msg && !stopped) {
    await run(app.update(msg)[1])
  }
}
const settle = () => new Promise((r) => setTimeout(r, options.settleMs || 8000))

let exitCode = 0
try {
  run(app.init())
  await settle()
  if (options.send) {
    app.editor.set(options.send)
    run(app.update(new tui.KeyMsg({ name: 'return', sequence: '\r' }))[1])
    await settle()
  }

  stopped = true
  fs.mkdirSync(output, { recursive: true })
  const pages = ['overview', 'device', 'models', 'chat']
  for (const page of pages) {
    app.page = page
    fs.writeFileSync(`${output}/${page}.ansi`, app.view())
  }

  app.editor.set('/')
  fs.writeFileSync(`${output}/chat-palette.ansi`, app.view())
  app.editor.reset()
  for (const name of options.open || []) {
    stopped = false
    run(app.openScreen(name))
    await new Promise((r) => setTimeout(r, 1500))
    fs.writeFileSync(`${output}/screen-${name}.ansi`, app.view())
    app.screen = null
  }

  stopped = true
  app.editor.reset()
  app.openChat(null)
  fs.writeFileSync(`${output}/chat-empty.ansi`, app.view())
  console.log(
    JSON.stringify({ captured: true, model: app.agent?.modelName, chats: app.chats.length })
  )
} catch (error) {
  console.error(error.stack || error)
  exitCode = 1
} finally {
  app.close()
  await host.close()
  Bare.exit(exitCode)
}
