const test = require('brittle')
const Supervisor = require('..')

function record(sup) {
  const log = []
  for (const event of [
    'child-ready',
    'child-died',
    'child-restarting',
    'child-stopped',
    'gave-up'
  ]) {
    sup.on(event, ({ name }) => log.push(event + ':' + name))
  }
  return log
}

function crashable(name, opts = {}) {
  const kills = {}
  const spec = {
    ...opts,
    backoff: opts.backoff ?? 5,
    start({ onDeath }) {
      const handle = { name, id: (kills[name] = (kills[name] ?? 0) + 1) }
      handle.kill = (err) => onDeath(err)
      return handle
    },
    stop: noop
  }
  return spec
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

test('death restarts the child with a fresh handle', async (t) => {
  const sup = new Supervisor()
  sup.add('a', crashable('a'))
  await sup.ready()
  t.teardown(() => sup.close())

  const first = sup.get('a')
  t.is(first.id, 1)

  const revived = once(sup, 'child-ready', 'a')
  first.kill(new Error('crashed'))
  t.alike(await revived, { name: 'a', lives: 2 })
  t.is(sup.get('a').id, 2)
  t.not(sup.get('a'), first)
})

test('dependents are stopped and restarted with the fresh handle', async (t) => {
  const sup = new Supervisor()
  const log = record(sup)
  const seen = []
  sup.add('a', crashable('a'))
  sup.add('b', {
    deps: ['a'],
    start: ({ get }) => {
      seen.push(get('a').id)
      return 'B'
    },
    stop: noop
  })
  sup.add('c', {
    deps: ['b'],
    start: () => 'C',
    stop: noop
  })
  await sup.ready()
  t.teardown(() => sup.close())

  log.length = 0
  const revived = once(sup, 'child-ready', 'c')
  sup.get('a').kill(new Error('crashed'))
  await revived

  t.alike(log, [
    'child-died:a',
    'child-stopped:c',
    'child-stopped:b',
    'child-stopped:a',
    'child-restarting:a',
    'child-ready:a',
    'child-ready:b',
    'child-ready:c'
  ])
  t.alike(seen, [1, 2])
})

test('stale and deliberate death signals are ignored', async (t) => {
  const sup = new Supervisor()
  sup.add('a', crashable('a'))
  await sup.ready()

  const first = sup.get('a')
  const revived = once(sup, 'child-ready', 'a')
  first.kill(new Error('crashed'))
  await revived

  first.kill(new Error('stale')) // old incarnation
  await new Promise((resolve) => setTimeout(resolve, 30))
  t.is(sup.get('a').id, 2)
  t.is(sup.inspect()[0].lives, 2)

  const second = sup.get('a')
  await sup.close()
  second.kill(new Error('during close')) // deliberate teardown
  t.is(sup.inspect()[0].state, 'stopped')
})

test('restart intensity exhausts into gave-up, supervisor stays up', async (t) => {
  const sup = new Supervisor()
  sup.add('a', crashable('a', { maxRestarts: 1 }))
  sup.add('b', { deps: ['a'], start: () => 'B', stop: noop })
  await sup.ready()
  t.teardown(() => sup.close())

  const revived = once(sup, 'child-ready', 'b')
  sup.get('a').kill(new Error('first'))
  await revived

  const gaveUp = once(sup, 'gave-up', 'a')
  sup.get('a').kill(new Error('second'))
  const { error } = await gaveUp
  t.is(error.message, 'second')

  const tree = sup.inspect()
  t.is(tree.find((c) => c.name === 'a').state, 'failed')
  t.is(tree.find((c) => c.name === 'b').state, 'stopped')
  t.is(sup.closed, false)
  t.exception(() => sup.get('a'), /not running/)
})

test('restart never gives up immediately', async (t) => {
  const sup = new Supervisor()
  const log = record(sup)
  sup.add('a', crashable('a', { restart: 'never' }))
  await sup.ready()
  t.teardown(() => sup.close())

  log.length = 0
  const gaveUp = once(sup, 'gave-up', 'a')
  sup.get('a').kill(new Error('crashed'))
  await gaveUp
  t.absent(log.includes('child-restarting:a'))
  t.is(sup.inspect()[0].state, 'failed')
})

test('start throws during revive count toward intensity', async (t) => {
  const sup = new Supervisor()
  let attempts = 0
  let kill = null
  sup.add('a', {
    maxRestarts: 2,
    backoff: 5,
    start({ onDeath }) {
      attempts++
      if (attempts > 1) throw new Error('still broken')
      kill = onDeath
      return 'A'
    }
  })
  await sup.ready()

  const gaveUp = once(sup, 'gave-up', 'a')
  kill(new Error('crashed'))
  await gaveUp
  t.is(attempts, 3) // boot + 2 failed revives
  await sup.close()
})

test('death during startup fails the start instead of hanging on ready', async (t) => {
  const sup = new Supervisor()
  sup.add('a', {
    restart: 'never',
    start({ onDeath }) {
      setTimeout(() => onDeath(new Error('died booting')), 5)
      return { ready: () => new Promise(noop) }
    }
  })
  await t.exception(() => sup.ready(), /died booting/)
})

test('death during a revive start counts toward intensity', async (t) => {
  const sup = new Supervisor()
  let boots = 0
  sup.add('a', {
    maxRestarts: 1,
    backoff: 5,
    start({ onDeath }) {
      boots++
      if (boots === 1) return { kill: onDeath }
      setTimeout(() => onDeath(new Error('died booting')), 5)
      return { ready: () => new Promise(noop) }
    },
    stop: noop
  })
  await sup.ready()

  const gaveUp = once(sup, 'gave-up', 'a')
  sup.get('a').kill(new Error('crashed'))
  await gaveUp
  t.is(boots, 2)
  t.is(sup.inspect()[0].state, 'failed')
  await sup.close()
})

test('a doomed start whose ready never settles does not wedge the respawn', async (t) => {
  const sup = new Supervisor({ stallTimeout: 50 })
  let boots = 0
  sup.add('a', {
    backoff: 5,
    start({ onDeath }) {
      boots++
      if (boots === 2) {
        setTimeout(() => onDeath(new Error('died booting')), 5)
        return { ready: () => new Promise(noop) } // release chains off this — a never-settling ready must not block the next start
      }
      return { kill: onDeath }
    },
    stop: noop
  })
  await sup.ready()
  t.teardown(() => sup.close())

  const stalled = once(sup, 'stall', 'a')
  const revived = once(sup, 'child-ready', 'a')
  sup.get('a').kill(new Error('crashed'))

  await stalled // the drain hit its bound instead of hanging on the doomed handle
  t.alike(await revived, { name: 'a', lives: 2 })
  t.is(boots, 3) // boot, doomed revive, healthy revive
})

async function until(t, fn) {
  const deadline = Date.now() + 10_000
  while (Date.now() < deadline) {
    if (fn()) return
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  t.fail('condition never held')
}

function states(sup) {
  return Object.fromEntries(sup.inspect().map((c) => [c.name, c.state]))
}

test('a death during boot restarts only after ready completes', async (t) => {
  const sup = new Supervisor()
  let kill = null
  sup.add('a', {
    backoff: 5,
    start({ onDeath }) {
      kill = onDeath
      return 'A'
    },
    stop: noop
  })
  sup.add('b', {
    start: async () => {
      kill(new Error('died mid-boot'))
      await new Promise((resolve) => setTimeout(resolve, 20))
      return 'B'
    }
  })
  await sup.ready()
  t.teardown(() => sup.close())
  await until(t, () => sup.inspect()[0].lives === 2)
  t.pass('the boot-time death was honored after boot, never interleaved')
})

test('concurrent deaths do not strand a shared dependent', async (t) => {
  const sup = new Supervisor()
  const kills = {}
  let releaseD = null
  let dStops = 0
  const dep = (name) => ({
    backoff: 5,
    start({ onDeath }) {
      kills[name] = onDeath
      return name.toUpperCase()
    },
    stop: noop
  })
  sup.add('x', dep('x'))
  sup.add('y', dep('y'))
  sup.add('d', {
    deps: ['x', 'y'],
    backoff: 5,
    start: () => 'D',
    stop: () => {
      dStops++
      if (dStops === 1) return new Promise((resolve) => (releaseD = resolve))
    }
  })
  await sup.ready()
  t.teardown(() => sup.close())

  kills.y(new Error('y died'))
  await until(t, () => releaseD !== null) // y's restart is parked stopping d
  kills.x(new Error('x died'))
  releaseD()

  await until(t, () => {
    const s = states(sup)
    return s.x === 'running' && s.y === 'running' && s.d === 'running'
  })
  t.pass('d was reconciled back up after both deps recovered')
})

test('a stale queued restart is dropped once another transition revived the child', async (t) => {
  const sup = new Supervisor()
  const kills = {}
  let releaseC = null
  let cStops = 0
  const child = (name, deps) => ({
    deps,
    backoff: 5,
    start({ onDeath }) {
      kills[name] = onDeath
      return name.toUpperCase()
    },
    stop: noop
  })
  sup.add('a', child('a'))
  sup.add('b', child('b', ['a']))
  sup.add('c', {
    deps: ['b'],
    backoff: 5,
    start: () => 'C',
    stop: () => {
      cStops++
      if (cStops === 1) return new Promise((resolve) => (releaseC = resolve))
    }
  })
  await sup.ready()
  t.teardown(() => sup.close())

  kills.a(new Error('a died'))
  await until(t, () => releaseC !== null) // a's restart is parked stopping c
  kills.b(new Error('b died independently'))
  releaseC()

  await until(t, () => {
    const s = states(sup)
    return s.a === 'running' && s.b === 'running' && s.c === 'running'
  })
  t.is(sup.inspect().find((c) => c.name === 'b').lives, 2, 'the stale restart did not recycle b')
})

test('a death in the gap after start resolves still fails the start', async (t) => {
  const sup = new Supervisor()
  sup.add('a', {
    restart: 'never',
    start({ onDeath }) {
      return {
        ready: async () => {
          queueMicrotask(() => onDeath(new Error('gap death')))
        }
      }
    }
  })
  await t.exception(() => sup.ready(), /gap death/)
})

test('backoff grows exponentially per death in the window, capped by maxBackoff', async (t) => {
  const sup = new Supervisor()
  let kill = null
  sup.add('a', {
    maxRestarts: 3,
    backoff: 10,
    maxBackoff: 25,
    start({ onDeath }) {
      if (kill) throw new Error('still broken')
      kill = onDeath
      return 'A'
    }
  })
  await sup.ready()

  const delays = []
  sup.on('child-restarting', ({ delay }) => delays.push(delay))
  const gaveUp = new Promise((resolve) => sup.once('gave-up', resolve))
  kill(new Error('crashed'))
  await gaveUp
  t.alike(delays, [10, 20, 25])
  await sup.close()
})

test('close during backoff cancels the restart', async (t) => {
  const sup = new Supervisor()
  sup.add('a', crashable('a', { backoff: 60_000 }))
  await sup.ready()

  const restarting = once(sup, 'child-restarting', 'a')
  sup.get('a').kill(new Error('crashed'))
  await restarting
  await sup.close()
  t.is(sup.inspect()[0].state, 'stopped')
  t.is(sup.inspect()[0].lives, 1)
})

function noop() {}
