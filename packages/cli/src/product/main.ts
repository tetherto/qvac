import type { CoreHost, LaunchOptions, RuntimeOptions } from '../lib/types.js'
import type { Command, HostStatus, ProductOptions } from './app-types.js'
import { startUpdater } from '../lib/runtime/updater.js'
import { bootCore } from '../lib/runtime/core-host.js'
import { hostIO } from '../lib/runtime/host-io.js'
import { bootLines } from './splash.js'
import { canvas, paint } from './theme.js'
import type { ProductApp } from './app.js'
import tui from 'bare-tui'
import pear from 'bare-tui-updater/pear'
import process from 'bare-process'
import fs from 'bare-fs'
import path from 'bare-path'
import b4a from 'b4a'
import { spawn, spawnSync } from 'bare-subprocess'
import updateBanner from 'bare-tui-updater'
import tty from 'bare-tty'
import pkg from '../../package.json' with { type: 'json' }
import { productApp } from './app.js'
import { runCommand } from '../cli/run.js'

let options: LaunchOptions = {}
let updates: Awaited<ReturnType<typeof startUpdater>> = null
let host: CoreHost | null = null
let program: InstanceType<typeof tui.Program> | null = null
let closing = false
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
function startApp() {
  try {
    const App = productApp(tui)

    return { type: 'app', app: new App(appOptions(hostIO())) }
  } catch (error) {
    return { type: 'start-error', error }
  }
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
    ...io,
    platform: process.platform,
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
  await host?.close()
  await updates?.close()
}
export async function main(launchOptions: LaunchOptions) {
  options = launchOptions
  if (options.runtimeConfig) {
    Object.assign(options, JSON.parse(fs.readFileSync(options.runtimeConfig!, 'utf8')))
  }

  options.version ??= pkg.version
  updates = options.standalone ? await startUpdater(options.entries!) : null
  if (options.command) {
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
    program.send(startApp())
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
