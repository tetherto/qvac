const test = require('brittle')
const fs = require('fs')
const os = require('os')
const stow = require('bare-stow')
const Supervisor = require('..')
const stowChildFactory = require('../stow')
const sidecar = require('../runner/sidecar')
const stowChild = (entry, opts = {}) => stowChildFactory(entry, { runner: sidecar, ...opts })

let stowed = null
function fixture() {
  stowed ??= (async () => {
    const outDir = `${__dirname}/fixtures/.stow/entry/`
    fs.rmSync(outDir, { recursive: true, force: true })
    const artifacts = stow(
      `file://${__dirname}/fixtures/entry-child.mjs`,
      'bare-sidecar',
      `file://${outDir}entry-child.js`,
      { base: `file://${__dirname}/../`, hosts: [`${os.platform()}-${os.arch()}`] }
    )
    return (async () => {
      for await (const artifact of artifacts) void artifact
      return `${outDir}entry-child.bundle`
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

test('stowEntry serves the tree and stops by EOF', async (t) => {
  const sup = new Supervisor()
  sup.add('child', stowChild(await fixture()))
  await sup.ready()

  t.is(await echo(sup.get('child'), 'ping'), 'ping', 'the tree booted and serves the wire')
  await sup.close()
  t.pass('stop resolved only after the real child exit')
})

test('stowEntry escalates a tree gave-up as exit(1)', async (t) => {
  const sup = new Supervisor()
  sup.add('child', stowChild(await fixture(), { restart: 'never' }))
  await sup.ready()
  t.teardown(() => sup.close())

  const died = once(sup, 'gave-up', 'child')
  sup.get('child').write(Buffer.from('giveup'))

  const { error } = await died
  t.ok(/exited \(1\)/.test(error.message), 'the tree exhaustion surfaced as exit code 1')
})
