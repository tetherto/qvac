const test = require('brittle')
const fs = require('fs')
const os = require('os')
const stow = require('bare-stow')
const Supervisor = require('..')
const stowChildFactory = require('../stow')
const sidecar = require('../runner/sidecar')
const stowChild = (entry, opts = {}) => stowChildFactory(entry, { runner: sidecar, ...opts })

test('reload restarts the child and its dependents with fresh handles, no death accounting', async (t) => {
  const sup = new Supervisor()
  const log = []
  let boots = 0
  sup.add('a', { start: () => ({ id: ++boots }), stop: noop })
  sup.add('b', {
    deps: ['a'],
    start: ({ get }) => `B over ${get('a').id}`,
    stop: noop
  })
  await sup.ready()
  t.teardown(() => sup.close())
  for (const event of ['child-died', 'child-reloaded', 'child-ready']) {
    sup.on(event, ({ name } = {}) => log.push(`${event}:${name}`))
  }

  const first = sup.get('a')
  await sup.reload('a')
  t.not(sup.get('a'), first)
  t.is(sup.get('b'), 'B over 2', 'the dependent rebuilt against the fresh handle')
  t.alike(log, ['child-ready:a', 'child-reloaded:a', 'child-ready:b'])
  t.absent(
    log.some((entry) => entry.startsWith('child-died')),
    'a reload is not a death'
  )
})

test('reload swaps in a new spec, or re-mints from a factory', async (t) => {
  const sup = new Supervisor()
  let minted = 0
  sup.add('a', () => {
    minted++
    return { start: () => `v${minted}`, stop: noop }
  })
  await sup.ready()
  t.teardown(() => sup.close())

  t.is(sup.get('a'), 'v1')
  await sup.reload('a')
  t.is(sup.get('a'), 'v2', 'the factory minted a fresh spec')
  await sup.reload('a', { start: () => 'pinned', stop: noop })
  t.is(sup.get('a'), 'pinned', 'an explicit spec wins')
})

test('reload recovers a failed child with a fresh intensity budget', async (t) => {
  const sup = new Supervisor()
  let kill = null
  sup.add('a', {
    restart: 'never',
    start({ onDeath }) {
      kill = onDeath
      return 'A'
    },
    stop: noop
  })
  await sup.ready()
  t.teardown(() => sup.close())

  const gaveUp = new Promise((resolve) => sup.once('gave-up', resolve))
  kill(new Error('crashed'))
  await gaveUp
  t.is(sup.inspect()[0].state, 'failed')

  await sup.reload('a')
  t.is(sup.inspect()[0].state, 'running', 'reload is the manual recovery path after gave-up')
  t.is(sup.inspect()[0].error, undefined)
})

test('a failed reload surfaces to the caller and a later reload recovers', async (t) => {
  const sup = new Supervisor()
  sup.add('a', { start: () => 'A', stop: noop })
  sup.add('b', { deps: ['a'], start: () => 'B', stop: noop })
  await sup.ready()
  t.teardown(() => sup.close())

  await t.exception(
    () =>
      sup.reload('a', {
        start: () => {
          throw new Error('broken upgrade')
        }
      }),
    /broken upgrade/
  )
  t.is(sup.inspect()[0].state, 'stopped')
  t.is(sup.inspect()[1].state, 'stopped', 'dependents wait for a working upgrade')

  await sup.reload('a', { start: () => 'A2', stop: noop })
  t.is(sup.get('a'), 'A2')
  t.is(sup.get('b'), 'B', 'the working upgrade reconciled the dependents')
})

test('reload picks up a replaced stow bundle — hot code reload end to end', async (t) => {
  const dyn = `${__dirname}/fixtures/.stow/dyn/`
  fs.rmSync(dyn, { recursive: true, force: true })
  fs.mkdirSync(dyn, { recursive: true })
  const source = `${dyn}child.mjs`

  const write = (version) =>
    fs.writeFileSync(
      source,
      `/* global Bare */
export default async function start(ipc, ready) {
  Bare.IPC.on('end', () => Bare.exit(0)).on('close', () => Bare.exit(0))
  ipc.on('data', () => ipc.write(Buffer.from('${version}')))
  ready()
  return () => {}
}
`
    )

  const bundle = async () => {
    const artifacts = stow(`file://${source}`, 'bare-sidecar', `file://${dyn}child.js`, {
      base: `file://${__dirname}/../`,
      hosts: [`${os.platform()}-${os.arch()}`]
    })
    for await (const artifact of artifacts) void artifact
    return `${dyn}child.bundle`
  }

  write('v1')
  const entry = await bundle()
  const sup = new Supervisor()
  sup.add('child', () => stowChild(entry))
  await sup.ready()
  t.teardown(() => sup.close())

  const ask = (ipc) =>
    new Promise((resolve) => {
      ipc.on('data', (data) => resolve(data.toString()))
      ipc.write(Buffer.from('?'))
    })
  t.is(await ask(sup.get('child')), 'v1')

  write('v2')
  await bundle()
  await sup.reload('child')
  t.is(await ask(sup.get('child')), 'v2', 'the respawned process runs the replaced bundle')
})

function noop() {}
