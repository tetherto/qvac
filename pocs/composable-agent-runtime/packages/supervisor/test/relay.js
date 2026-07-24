const test = require('brittle')
const fs = require('fs')
const os = require('os')
const stow = require('bare-stow')
const Sidecar = require('bare-sidecar')
const Supervisor = require('..')
const stowChildFactory = require('../stow')
const relayRunner = require('../runner/relay')
const serveSpawner = require('../host/spawner')

// A linked pair of control sidebands: send() on one end fires the matching listeners on
// the other, carrying the full message — exactly how the stow IPC dispatches CONTROL frames.
function controlPair() {
  const make = () => {
    const listeners = new Map()
    return {
      on(type, cb) {
        if (!listeners.has(type)) listeners.set(type, new Set())
        listeners.get(type).add(cb)
      },
      off(type, cb) {
        listeners.get(type)?.delete(cb)
      },
      _emit(type, message) {
        for (const cb of [...(listeners.get(type) ?? [])]) cb(message)
      }
    }
  }
  const a = make()
  const b = make()
  a.send = (type, payload) => b._emit(type, { type, ...payload })
  b.send = (type, payload) => a._emit(type, { type, ...payload })
  return [a, b]
}

// The host's spawn primitive stands in for `new Worklet()`: a raw bare-sidecar process
// whose pipe the spawner pumps over the control sideband — the relay logic is identical.
function rawSidecar(entry, args) {
  const child = new Sidecar(entry, args)
  return { ipc: child, exit: new Promise((resolve) => child.once('exit', resolve)) }
}

let stowed = null
function fixture() {
  stowed ??= (async () => {
    const outDir = `${__dirname}/fixtures/.stow/relay/`
    fs.rmSync(outDir, { recursive: true, force: true })
    const artifacts = stow(
      `file://${__dirname}/fixtures/child.mjs`,
      'bare-sidecar',
      `file://${outDir}child.js`,
      { base: `file://${__dirname}/../`, hosts: [`${os.platform()}-${os.arch()}`] }
    )
    return (async () => {
      for await (const artifact of artifacts) void artifact
      return `${outDir}child.bundle`
    })()
  })()
  return stowed
}

function once(sup, event, name) {
  return new Promise((resolve) => {
    const listener = (payload) => {
      if (name && payload.name !== name) return
      sup.off(event, listener)
      resolve(payload)
    }
    sup.on(event, listener)
  })
}

function echo(ipc, text) {
  return new Promise((resolve) => {
    ipc.on('data', (data) => resolve(data.toString()))
    ipc.write(Buffer.from(text))
  })
}

test('relay: a host-spawned stow child serves the wire through the control sideband', async (t) => {
  const [hostControl, workletControl] = controlPair()
  const closeSpawner = serveSpawner(hostControl, rawSidecar)
  t.teardown(closeSpawner)

  const sup = new Supervisor()
  sup.add('child', stowChildFactory(await fixture(), { runner: relayRunner(workletControl) }))
  await sup.ready()

  t.is(await echo(sup.get('child'), 'ping'), 'ping', 'the relayed child serves the wire')
  await sup.close()
  t.pass('stop propagated through the relay and the child exited')
})

test('relay: a child crash surfaces as death and the supervisor respawns it', async (t) => {
  const [hostControl, workletControl] = controlPair()
  const closeSpawner = serveSpawner(hostControl, rawSidecar)
  t.teardown(closeSpawner)

  const sup = new Supervisor()
  sup.add(
    'child',
    stowChildFactory(await fixture(), { runner: relayRunner(workletControl), backoff: 5 })
  )
  await sup.ready()
  t.teardown(() => sup.close())

  const first = sup.get('child')
  const died = once(sup, 'child-died', 'child')
  const revived = once(sup, 'child-ready', 'child')
  first.write(Buffer.from('die'))

  const { error } = await died
  t.ok(/exited \(7\)/.test(error.message), 'death carries the relayed exit code')
  t.alike(await revived, { name: 'child', lives: 2 })
  t.is(await echo(sup.get('child'), 'ping'), 'ping', 'the respawned child serves the wire')
})

// a child whose process-exit resolves before its pipe finishes draining — the tail-loss race
function fakeChildIpc() {
  const listeners = new Map()
  return {
    on(type, cb) {
      if (!listeners.has(type)) listeners.set(type, new Set())
      listeners.get(type).add(cb)
      return this
    },
    emit(type, arg) {
      for (const cb of [...(listeners.get(type) ?? [])]) cb(arg)
    },
    write() {
      return true
    },
    destroy() {
      this.emit('close')
    },
    pause() {},
    resume() {}
  }
}

test('relay: the exit frame never overtakes trailing data (no tail loss)', async (t) => {
  const [hostControl, workletControl] = controlPair()
  const frames = []
  workletControl.on('stow-relay:data', (m) => frames.push(m))
  workletControl.on('stow-relay:exit', (m) => frames.push(m))

  const ipc = fakeChildIpc()
  let resolveExit
  const exit = new Promise((resolve) => (resolveExit = resolve))
  const closeSpawner = serveSpawner(hostControl, () => ({ ipc, exit }))
  t.teardown(closeSpawner)

  workletControl.send('stow-relay:spawn', { id: 1, entry: 'x', args: [] })

  ipc.emit('data', Buffer.from('a'))
  resolveExit(0) // the process exit resolves...
  await Promise.resolve() // ...and its handler runs, but the readable has not ended yet
  ipc.emit('data', Buffer.from('b')) // a trailing frame still arrives
  ipc.emit('end') // only now is the readable drained

  const types = frames.map((f) => f.type)
  const exitAt = types.indexOf('stow-relay:exit')
  t.not(exitAt, -1, 'the exit frame was sent')
  t.is(types.filter((type) => type === 'stow-relay:data').length, 2, 'both data frames relayed')
  t.is(
    frames.slice(exitAt).filter((f) => f.type === 'stow-relay:data').length,
    0,
    'no data frame followed the exit frame'
  )
})
