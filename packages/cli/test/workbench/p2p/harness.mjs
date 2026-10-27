// Real `qvac serve` devices on a private test DHT, each in its own process group and data folder.
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import createTestnet from 'hyperdht/testnet.js'

const CLI = new URL('../../../dist/index.js', import.meta.url).pathname

export async function network(t) {
  const testnet = await createTestnet(3)
  const devices = []
  const bootstrap = testnet.bootstrap.map((node) => `${node.host}:${node.port}`).join(',')
  // a device left running would sit on the next run's network and stall its connections
  t.after(async () => {
    for (const device of devices) {
      await device.kill()
    }

    await testnet.destroy()
    for (const device of devices) {
      // P2P_KEEP leaves the data folders, logs included, to read after a failure
      if (process.env.P2P_KEEP) {
        console.log(`kept ${device.name}: ${device.dir}`)
      } else {
        fs.rmSync(device.dir, { recursive: true, force: true })
      }
    }
  })

  const device = (name, args = []) => {
    const d = new Device(name, { bootstrap, args })
    devices.push(d)
    return d
  }

  return { device, devices, bootstrap }
}

class Device {
  constructor(name, { bootstrap, args }) {
    this.name = name
    this.dir = fs.mkdtempSync(path.join(os.tmpdir(), `qvac-p2p-${name}-`))
    this.bootstrap = bootstrap
    this.args = args
    this.child = null
    this.events = []
  }

  start(args = this.args) {
    this.events = []
    this.liveReady = false
    this.exited = null
    this.stopping = false
    this.child = spawn(
      'node',
      [CLI, 'serve', '--json', '--non-interactive', '--fake-models', '--no-default-models'].concat(
        ['--data-dir', this.dir, '--device-name', this.name, '--bootstrap', this.bootstrap],
        args
      ),
      { stdio: ['ignore', 'pipe', 'pipe'], detached: true }
    )
    // what serve said and why it stopped, kept beside the logs for P2P_KEEP
    const out = fs.createWriteStream(path.join(this.dir, 'serve.out'), { flags: 'a' })
    this.child.stdout.on('data', (data) => out.write(data))
    this.child.stderr.on('data', (data) => out.write(data))
    this.child.once('exit', (code, signal) => {
      this.exited = { code, signal }
      out.end(`[exit ${code ?? signal}]\n`)
    })
    let buffer = ''
    this.ready = new Promise((resolve, reject) => {
      this.child.stdout.on('data', (data) => {
        buffer += data
        for (let at = buffer.indexOf('\n'); at >= 0; at = buffer.indexOf('\n')) {
          const event = JSON.parse(buffer.slice(0, at))
          buffer = buffer.slice(at + 1)
          this.events.push(event)
          if (event.status === 'ready') {
            this.liveReady = true
            resolve(event)
          }
        }
      })
      this.child.once('exit', (code) => reject(new Error(`${this.name} exited ${code}`)))
    })
    // a joiner is ready only once joined; convergence, not this, is what a test waits on
    this.ready.catch(noop)

    return this.ready
  }

  // the status copy serve keeps; null while it is down or before its first write
  status() {
    if (!this.liveReady) return null
    try {
      return JSON.parse(fs.readFileSync(path.join(this.dir, 'cli-serve-status.json'), 'utf8'))
    } catch {
      return null
    }
  }

  tail() {
    try {
      return fs
        .readFileSync(path.join(this.dir, 'serve.out'), 'utf8')
        .trim()
        .split('\n')
        .slice(-6)
        .join(' | ')
    } catch {
      return ''
    }
  }

  async stop() {
    if (!this.child || this.child.exitCode !== null) {
      return
    }

    this.stopping = true
    const exited = new Promise((resolve) => this.child.once('exit', resolve))
    process.kill(-this.child.pid, 'SIGTERM')
    await exited
  }

  async kill() {
    const child = this.child
    if (!child || child.exitCode !== null || child.signalCode !== null) return
    const exited = new Promise((resolve) => child.once('exit', resolve))
    try {
      process.kill(-child.pid, 'SIGKILL')
      await exited
    } catch {}
  }
}

// Every running device sees the workspace joined with this many members.
export async function converged(devices, members, { timeoutMs = 180000, everyMs = 2000 } = {}) {
  const started = Date.now()
  const deadline = started + timeoutMs
  let seen = []
  while (Date.now() < deadline) {
    // a device that stopped is never going to converge, and its status copy would hide that
    const gone = devices.find((d) => d.exited && !d.stopping)
    if (gone) {
      throw new Error(
        `${gone.name} exited ${gone.exited.code ?? gone.exited.signal}: ${gone.tail()}`
      )
    }

    // Core also lists each user's personal workspace, in no guaranteed order.
    const workspaces = devices.map((device) => device.status()?.workspaces ?? [])
    const shared = workspaces[0]?.find((workspace) =>
      workspaces.every((list) =>
        list.some(
          (entry) =>
            entry.meshId === workspace.meshId &&
            entry.state === 'joined' &&
            entry.members === members
        )
      )
    )
    seen = devices.map((device, index) => {
      const workspace =
        workspaces[index].find((entry) => entry.meshId === shared?.meshId) ?? workspaces[index][0]
      return `${device.name} ${workspace?.state}/${workspace?.members}`
    })
    if (shared) {
      console.log(
        `converged on ${members} members in ${Math.round((Date.now() - started) / 1000)}s`
      )
      return seen
    }

    await new Promise((resolve) => setTimeout(resolve, everyMs))
  }

  throw new Error(`no convergence on ${members} members: ${seen.join(' · ')}`)
}

function noop() {}
