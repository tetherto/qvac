const test = require('brittle')
const fs = require('fs')
const os = require('os')
const stow = require('bare-stow')
const Supervisor = require('..')
const stowChildFactory = require('../stow')
const sidecar = require('../runner/sidecar')
const stowChild = (entry, opts = {}) => stowChildFactory(entry, { runner: sidecar, ...opts })

// The fixture is stowed like a real worker bundle, so tests walk the exact
// production spawn path (stow shim + protocol + Sidecar).
let stowed = null
function fixture() {
  stowed ??= (async () => {
    const outDir = `${__dirname}/fixtures/.stow/`
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

test('stowChild boots a real process, serves the wire, stops by EOF', async (t) => {
  const sup = new Supervisor()
  sup.add('child', stowChild(await fixture()))
  await sup.ready()

  t.is(await echo(sup.get('child'), 'ping'), 'ping')
  await sup.close()
  t.pass('stop resolved only after the real child exit')
})

test('stowChild reports a crash as death and the supervisor respawns it', async (t) => {
  const sup = new Supervisor()
  sup.add('child', stowChild(await fixture(), { backoff: 5 }))
  await sup.ready()
  t.teardown(() => sup.close())

  const first = sup.get('child')
  const died = once(sup, 'child-died', 'child')
  const revived = once(sup, 'child-ready', 'child')
  first.write(Buffer.from('die'))

  const { error } = await died
  t.ok(/exited \(7\)/.test(error.message), 'death carries the exit code')
  t.alike(await revived, { name: 'child', lives: 2 })

  const second = sup.get('child')
  t.not(second, first)
  t.is(await echo(second, 'ping'), 'ping', 'the respawned process serves the wire')
})

test('stowChild exit before ready fails the start', async (t) => {
  const sup = new Supervisor()
  sup.add('child', stowChild(await fixture(), { args: ['die-early'] }))
  await t.exception(() => sup.ready(), /exited \(3\) before ready/)
})

test('stowChild create failure does not leak the child', async (t) => {
  const sup = new Supervisor()
  sup.add(
    'child',
    stowChild(await fixture(), {
      restart: 'never',
      create: () => {
        throw new Error('create boom')
      }
    })
  )
  await t.exception(() => sup.ready(), /create boom/)
  t.pass('the failed start awaited the real child exit')
})

test('a stowChild spec is single-use', async (t) => {
  const spec = stowChild(await fixture())
  const sup = new Supervisor()
  sup.add('one', spec)
  sup.add('two', spec)
  await t.exception(() => sup.ready(), /single-use/)
})
