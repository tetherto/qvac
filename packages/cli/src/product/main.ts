import type { CoreHost, LaunchOptions, RuntimeOptions } from '../lib/types.js'
import type { Command, HostStatus, ProductOptions } from './app-types.js'
import type { ProductApp } from './app.js'
import tui from 'bare-tui'
import pear from 'bare-tui-updater/pear'
import { startUpdater } from '../lib/runtime/updater.js'
import process from 'bare-process'
import fs from 'bare-fs'
import path from 'bare-path'
import os from 'bare-os'
import b4a from 'b4a'
import URL, { pathToFileURL } from 'bare-url'
import { spawn, spawnSync } from 'bare-subprocess'
import updateBanner from 'bare-tui-updater'
import tty from 'bare-tty'
import pkg from '../../package.json' with { type: 'json' }
import { bootCore } from '../lib/runtime/core-host.js'
import { extensionImports } from './extension-imports.js'
import { listFiles } from '../lib/runtime/files.js'
import { hostIO } from '../lib/runtime/host-io.js'
import { loadTemplates, loadContextFiles, contextPreamble } from '../lib/runtime/resources.js'
import { screens } from './screens.js'
import { pluginsScreen } from './plugins-screen.js'
import { readPluginState, writePluginState } from '../lib/runtime/plugin-state.js'
import { productApp } from './app.js'
import { loadExtensions } from './extension-loader.js'
import { watchFiles, extensionFiles } from './config-watch.js'
import { bootLines } from './splash.js'
import type { PrintIO } from './print.js'
import { runPrint } from './print.js'
import { runCommand } from '../cli/run.js'
import { canvas, paint } from './theme.js'

let options: LaunchOptions = {}
let updates: Awaited<ReturnType<typeof startUpdater>> = null
let host: CoreHost | null = null
let program: InstanceType<typeof tui.Program> | null = null
let stopWatching: (() => void) | null = null,
  closing = false,
  loads = 0
const originalConsole = { ...console }
const CLIPBOARD_COMMANDS: Record<string, [string, string[]][]> = {
  darwin: [['pbcopy', []]],
  win32: [['clip', []]],
  linux: [
    ['wl-copy', []],
    ['xclip', ['-selection', 'clipboard']],
    ['xsel', ['--clipboard', '--input']]
  ]
}

// piped to the platform clipboard command so nothing reaches the tty; first to exit 0 wins
function copyToClipboard(text: string) {
  const commands = CLIPBOARD_COMMANDS[process.platform] ?? CLIPBOARD_COMMANDS['linux']!
  return new Promise<void>((resolve, reject) => {
    const attempt = (i: number) => {
      if (i >= commands.length) {
        reject(new Error('no clipboard command available'))
        return
      }

      const [cmd, args] = commands[i]!
      let child
      try {
        child = spawn(cmd, args, { stdio: ['pipe', 'ignore', 'ignore'] })
      } catch {
        attempt(i + 1)
        return
      }

      child.on('error', () => attempt(i + 1))
      child.on('exit', (code) => (code === 0 ? resolve() : attempt(i + 1)))
      child.stdin!.write(text)
      child.stdin!.end()
    }
    attempt(0)
  })
}

// no display (a container, ssh): ask the host terminal to set its clipboard instead
function copyViaTerminal(program: { output: { write: (arg0: string) => void } }, text: string) {
  program!.output.write(`\x1b]52;c;${b4a.toString(b4a.from(text), 'base64')}\x07`)
}

function readClipboard() {
  const commands: [string, string[]][] =
    process.platform === 'darwin'
      ? [['pbpaste', []]]
      : [
          ['wl-paste', ['--no-newline']],
          ['xclip', ['-o', '-selection', 'clipboard']],
          ['xsel', ['--clipboard', '--output']]
        ]
  return new Promise<string>((resolve, reject) => {
    const attempt = (i: number) => {
      if (i >= commands.length) {
        reject(new Error('no clipboard command available'))
        return
      }

      const [cmd, args] = commands[i]!
      let child
      try {
        child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'ignore'] })
      } catch {
        attempt(i + 1)
        return
      }

      const out: Uint8Array[] = []
      child.stdout!.on('data', (data) => out.push(data as Uint8Array))
      child.on('error', () => attempt(i + 1))
      child.on('exit', (code) =>
        code === 0 ? resolve(b4a.concat(out).toString()) : attempt(i + 1)
      )
    }
    attempt(0)
  })
}

const MIME_TYPES = new Map([
  ['.png', 'image/png'],
  ['.jpg', 'image/jpeg'],
  ['.jpeg', 'image/jpeg'],
  ['.gif', 'image/gif'],
  ['.webp', 'image/webp'],
  ['.heic', 'image/heic'],
  ['.heif', 'image/heif'],
  ['.pdf', 'application/pdf'],
  ['.txt', 'text/plain'],
  ['.md', 'text/markdown'],
  ['.json', 'application/json']
])
// the engine's own cap (lib/core/files/attachments.ts); a lower one here refused files it takes
const MAX_ATTACHMENT_BYTES = 100 * 1024 * 1024

// raw image data on the clipboard has no portable tty-side accessor, so only file paths attach
async function resolvePastedFile() {
  const text = (await readClipboard()).trim()
  if (!text || text.includes('\n')) {
    return null
  }

  const file = expandFilePath(text)
  let stat
  try {
    stat = fs.statSync(file)
  } catch {
    return null
  }

  if (!stat.isFile()) {
    return null
  }

  return fileToAttachment(file, stat)
}

// `/attach` resolver: a named path -> attachment; throws on a bad path.
function resolveFileAttachment(pathString: string) {
  return fileToAttachment(expandFilePath(pathString))
}

function expandFilePath(text: string) {
  const file = text.startsWith('file://') ? decodeURI(text.slice('file://'.length)) : text
  return file.startsWith('~/') ? path.join(os.homedir(), file.slice(2)) : file
}

function fileToAttachment(file: string, stat = fs.statSync(file)) {
  if (!stat.isFile()) throw new Error('not a regular file')
  if (stat.size > MAX_ATTACHMENT_BYTES) {
    throw new Error(`file too large (${MAX_ATTACHMENT_BYTES / (1024 * 1024)}MB cap)`)
  }

  return {
    fileName: path.basename(file),
    mimeType: MIME_TYPES.get(path.extname(file).toLowerCase()) ?? 'application/octet-stream',
    data: fs.readFileSync(file) as Uint8Array
  }
}

async function connect() {
  host = await bootCore(options)
  return {
    engine: host.engine,
    skills: host.skills,
    deviceId: host!.deviceId,
    meshInvite: host.meshInvite,
    modelName: host.modelName,
    // what onboarding fills in, to keep or edit: flag or qvac.config first, then $USER and the hostname
    setupNames: {
      account: options.accountName || process.env['USER'] || '',
      device: host.deviceName
    },
    configure: () => host!.configure()
  }
}
async function startApp() {
  try {
    const App = productApp(tui)
    const extensions = await extensionsNow()
    watchConfig()

    return { type: 'app', app: new App({ ...appOptions(hostIO()), extensions }) }
  } catch (error) {
    return { type: 'start-error', error }
  }
}

function extensionsNow() {
  const version = loads++
  return loadExtensions(options.config?.tui?.extensions, {
    configPath: options.configPath,
    load: (file) => importFromConfig(file, version)
  })
}

// An edit to qvac.config, or to an extension it lists, applies at once; plugins wait for a restart.
function watchConfig() {
  if (!options.configPath || !options.launcher) {
    return
  }

  stopWatching?.()
  stopWatching = watchFiles(
    extensionFiles(options.configPath, options.config?.tui?.extensions),
    async () => {
      const plugins = JSON.stringify(options.config?.harness?.plugins)
      try {
        reloadConfig()
        const loaded = await extensionsNow()
        const changed = plugins !== JSON.stringify(options.config?.harness?.plugins)
        program!.send({ type: 'extensions.reloaded', loaded, pluginsChanged: changed })
      } catch (error) {
        program!.send({ type: 'error', error })
      }

      watchConfig()
    }
  )
}

// An extension in any project can import @qvac/harness from this install; ?v= imports it afresh.
async function importFromConfig(file: string, version: number) {
  const base = options.configPath ? path.dirname(options.configPath) : process.cwd()
  const self = import.meta.cache[import.meta.url]!
  const url = new URL(`${pathToFileURL(path.resolve(base, file)).href}?v=${version}`)

  return (
    await (self.constructor as typeof import('bare-module')).load(url, {
      referrer: self,
      imports: extensionImports()
    })
  ).exports as { default?: unknown }
}

export function appOptions(io: ReturnType<typeof hostIO>): ProductOptions {
  return {
    ...options,
    updateBanner: updates
      ? updateBanner.create({
          onAccept: () => updates!.updater.applyUpdate(),
          acceptKey: 'ctrl+u'
        })
      : null,
    connect,
    copyToClipboard: async (text) => {
      try {
        await copyToClipboard(text)
      } catch {
        copyViaTerminal(program!, text)
      }
    },
    resolveFileAttachment,
    resolvePastedFile,
    ...io,
    // a paused tty stream keeps its native read, so the editor and the TUI would race for keys
    editExternal: async (text) => {
      program!.input.destroy()
      try {
        return await io.editExternal(text)
      } finally {
        program!.input = new tty.ReadStream(0)
      }
    },
    listFiles: () => listFiles(io.cwd),
    loadTemplates: () => loadTemplates({ cwd: io.cwd }),
    loadContext: () => loadContextFiles({ cwd: io.cwd }),
    screens: { ...screens, plugins: pluginsScreen },
    platform: process.platform,
    readPluginState: () => readPluginState(options.dataDir!, fs),
    writePluginState: (state) => writePluginState(options.dataDir!, state, fs),
    restartCore: async () => {
      reloadConfig()
      await host?.close()
      return connect()
    },
    readHostStatus,
    resolveDirectory: async (value: string) => {
      const dir = path.resolve(value)
      if (!fs.statSync(dir).isDirectory()) {
        throw new Error('Choose a directory')
      }

      return dir
    },
    requestRepaint: () => program!.repaint(),
    post: (msg) => program!.send(msg)
  }
}

// qvac.config is read by the launcher, so a restart asks it again; a bad edit keeps Core running.
function reloadConfig() {
  if (!options.launcher) {
    return
  }

  const { runtime, script } = options.launcher
  const args = [script!, '__runtime-config', options.runtimeConfig!, options.configFile || '']
  const { status, stderr } = spawnSync(runtime, args)
  if (status !== 0) {
    throw new Error(b4a.toString(stderr!).trim() || 'qvac.config did not reload')
  }

  Object.assign(options, JSON.parse(fs.readFileSync(options.runtimeConfig!, 'utf8')))
}

function readHostStatus(): HostStatus | null {
  try {
    return JSON.parse(fs.readFileSync(path.join(options.dataDir!, 'cli-host-status.json'), 'utf8'))
  } catch {
    return null
  }
}

class Starting {
  width = 80
  height = 24
  error: Error | null = null

  update(msg: { type: string }): [Starting | ProductApp, Command] {
    if (msg.type === 'app') {
      const app = (msg as { type: string; app: ProductApp }).app
      if (updates) {
        pear.wire(app.updateBanner, {
          updater: updates.updater,
          send: (message: unknown) => program!.send(message)
        })
      }

      app.width = this.width
      app.height = this.height

      return [app, app.init()]
    }

    if (msg.type === 'resize') {
      this.width = (msg as { type: string; width: number }).width
      this.height = (msg as { type: string; height: number }).height
    }

    if (msg.type === 'start-error') {
      this.error = (msg as { type: string; error: Error }).error
    }

    if (msg.type === 'key' && tui.key.matches(msg, 'ctrl+c')) {
      return [this, tui.quit]
    }

    return [this, null]
  }

  view() {
    const f = canvas({
      width: this.width,
      height: this.height,
      measure: tui.style.width,
      color: !options.noColor,
      theme: options.theme
    })
    return f.render([
      ...bootLines(f, {
        height: this.height - 2,
        status: this.error ? this.error.message : paint('Starting QV.AC…', 'muted')
      }),
      '',
      'Ctrl+C exit'
    ])
  }
}
async function close() {
  if (closing) return
  closing = true
  stopWatching?.()
  await host?.close()
  await updates?.close()
}
export async function main(launchOptions: LaunchOptions) {
  options = launchOptions
  if (options.runtimeConfig) {
    Object.assign(options, JSON.parse(fs.readFileSync(options.runtimeConfig!, 'utf8')))
  }

  options.version ??= pkg.version
  updates = options.standalone
    ? await startUpdater(options.entries as Parameters<typeof startUpdater>[0])
    : null
  if (options.mode) {
    await runPrintMode()
  } else if (options.command) {
    await runCli()
  } else {
    await runTui()
  }
}

function silenceConsole() {
  for (const method of ['log', 'info', 'warn', 'error', 'debug'] as const) {
    console[method] = () => {}
  }
}

async function runPrintMode() {
  silenceConsole()
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
    process.on(signal, () => void close().finally(() => Bare.exit(130)))
  }

  let code = 1
  try {
    await connect()
    code = await runPrint(host!.engine, {
      deviceId: host!.deviceId,
      options: options,
      io: {
        stdout: process.stdout,
        stderr: process.stderr,
        stdin:
          options.mode === 'rpc' || options.stdinPiped ? (process.stdin as PrintIO['stdin']) : null,
        context: contextPreamble(loadContextFiles({ cwd: process.cwd() }))
      }
    })
  } catch (error) {
    process.stderr.write(`qvac: ${error instanceof Error ? error.message : String(error)}\n`)
  }

  await close()
  await endStreams()
  Bare.exit(code ?? 0)
}

async function runCli() {
  options.tty = { stdin: tty.isTTY(0), stdout: tty.isTTY(1), stderr: tty.isTTY(2) }
  const code = await runCommand(options as RuntimeOptions)
  await updates?.close()
  await endStreams()
  Bare.exit(code ?? 0)
}

async function endStreams() {
  for (const stream of [process.stdout, process.stderr]) {
    await new Promise<void>((resolve) => {
      stream.once('finish', resolve)
      stream.once('close', resolve)
      stream.end()
    })
  }
}

async function runTui() {
  silenceConsole()
  program = new tui.Program(new Starting(), {
    mouse: options.config?.tui?.['mouse'] === false ? false : 'drag'
  })
  program!.output.write('\x1b[?2004h')
  try {
    const running = program.run()
    startApp().then((msg) => program!.send(msg))
    // bare-tui cannot configure its decoder, whose 500ms escape wait lags every Esc and merges Esc+key
    if (program._decoder) {
      program._decoder._escapeDelay = 50
    }

    await running
  } finally {
    program!.output.write('\x1b[?2004l\x1b[0m')
    await close()
    Object.assign(console, originalConsole)
  }

  Bare.exit(0)
}
