// Drives the real qvac in a pseudo-terminal and keeps a Screen of what a terminal would show.
import { spawn } from 'node:child_process'
import path from 'node:path'
import { Screen } from './vt.mjs'

const BRIDGE = new URL('./pty-bridge.py', import.meta.url).pathname
const CLI = process.env.QVAC_CLI_TEST_PACKAGE
  ? path.resolve(process.env.QVAC_CLI_TEST_PACKAGE, 'dist/index.js')
  : new URL('../../../dist/index.js', import.meta.url).pathname

export function terminal(t, args, { rows = 30, cols = 100, cwd, env = {} } = {}) {
  const child = spawn('python3', [BRIDGE, rows, cols, 'node', CLI, ...args], {
    cwd,
    env: { ...process.env, ...env },
    stdio: ['pipe', 'pipe', 'pipe', 'pipe'],
    detached: true
  })
  const screen = new Screen(rows, cols)
  let last = Date.now()
  let exited = null
  child.stdout.setEncoding('utf8')
  child.stdout.on('data', (data) => {
    screen.write(data)
    last = Date.now()
  })
  child.on('exit', (code) => {
    exited = code
  })
  t.after(() => {
    try {
      process.kill(-child.pid, 'SIGKILL')
    } catch {}
  })

  const term = {
    screen,
    get exited() {
      return exited
    },
    keys(text) {
      child.stdin.write(text)
    },
    resize(r, c) {
      screen.resize(r, c)
      child.stdio[3].write(`resize ${r} ${c}\n`)
    },
    // the spinner and the uptime clock keep writing, so quiet means a gap between frames
    async quiet(ms = 60, timeout = 5000) {
      const end = Date.now() + timeout
      while (Date.now() < end) {
        if (Date.now() - last >= ms) return
        await sleep(10)
      }

      throw new Error(`the screen never went quiet for ${ms}ms`)
    },
    async waitFor(pattern, timeout = 60000) {
      const end = Date.now() + timeout
      while (Date.now() < end) {
        if (pattern.test(screen.text())) return
        if (exited !== null) {
          throw new Error(`qvac exited ${exited}\n${screen.text()}`)
        }

        await sleep(50)
      }

      throw new Error(`timed out waiting for ${pattern}\n${screen.text()}`)
    }
  }

  return term
}

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
