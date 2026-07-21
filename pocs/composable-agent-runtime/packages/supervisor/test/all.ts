import test from 'brittle'
import {
  Supervisor,
  type SupervisorEvent
} from '../src/index.ts'

test('starts in dependency order and closes in reverse order', async (t) => {
  const supervisor = new Supervisor()
  const log: string[] = []

  supervisor.add('api', {
    deps: ['database'],
    start({ get }) {
      log.push(`start:api:${get<{ id: number }>('database').id}`)
      return { id: 2 }
    },
    stop() {
      log.push('stop:api')
    }
  })
  supervisor.add('database', {
    start() {
      log.push('start:database')
      return { id: 1 }
    },
    stop() {
      log.push('stop:database')
    }
  })

  await supervisor.ready()
  t.alike(log, ['start:database', 'start:api:1'])
  await supervisor.close()
  t.alike(log, [
    'start:database',
    'start:api:1',
    'stop:api',
    'stop:database'
  ])
})

test('rejects unknown dependencies and dependency cycles', async (t) => {
  const unknown = new Supervisor()
  unknown.add('api', { deps: ['missing'], start: () => 'api' })
  await t.exception(unknown.ready(), /Unknown dependency: missing/)

  const cyclic = new Supervisor()
  cyclic.add('a', { deps: ['b'], start: () => 'a' })
  cyclic.add('b', { deps: ['a'], start: () => 'b' })
  await t.exception(cyclic.ready(), /Dependency cycle/)
})

test('explicit death restarts a child and reconstructs affected dependents', async (t) => {
  const supervisor = new Supervisor()
  const deaths: Array<(error?: Error) => void> = []
  const dependencyHandles: number[] = []
  let databaseGeneration = 0
  let metricsStarts = 0

  supervisor.add('database', {
    start({ onDeath }) {
      deaths.push(onDeath)
      return { generation: ++databaseGeneration }
    }
  })
  supervisor.add('api', {
    deps: ['database'],
    start({ get }) {
      const database = get<{ generation: number }>('database')
      dependencyHandles.push(database.generation)
      return { generation: database.generation }
    }
  })
  supervisor.add('metrics', {
    start() {
      metricsStarts++
      return { running: true }
    }
  })
  await supervisor.ready()

  const restarted = nextEvent(
    supervisor,
    (event) => event.type === 'child-ready' && event.name === 'api'
  )
  deaths[0]?.(new Error('database crashed'))
  await restarted

  t.alike(dependencyHandles, [1, 2])
  t.is(supervisor.get<{ generation: number }>('database').generation, 2)
  t.is(supervisor.get<{ generation: number }>('api').generation, 2)
  t.is(metricsStarts, 1)
  await supervisor.close()
})

test('a death signal raised by deliberate stop does not restart', async (t) => {
  const supervisor = new Supervisor()
  let starts = 0

  supervisor.add('worker', {
    start(context) {
      starts++
      return context
    },
    stop(context) {
      context.onDeath(new Error('exit event during close'))
    }
  })
  await supervisor.ready()
  await supervisor.close()

  t.is(starts, 1)
  t.is(supervisor.inspect()[0]?.state, 'stopped')
})

test('suspend runs in reverse order and resume runs forward', async (t) => {
  const supervisor = new Supervisor()
  const log: string[] = []
  const child = (name: string, deps: string[] = []) => ({
    deps,
    start: () => name,
    suspend: () => {
      log.push(`suspend:${name}`)
    },
    resume: () => {
      log.push(`resume:${name}`)
    }
  })
  supervisor.add('storage', child('storage'))
  supervisor.add('service', child('service', ['storage']))
  await supervisor.ready()

  await supervisor.suspend()
  await supervisor.resume()

  t.alike(log, [
    'suspend:service',
    'suspend:storage',
    'resume:storage',
    'resume:service'
  ])
  await supervisor.close()
})

test('inspect exposes stable lifecycle state and child-owned details', async (t) => {
  const supervisor = new Supervisor()
  supervisor.add('worker', {
    start: () => ({ queued: 3 }),
    inspect: (handle) => ({ queued: handle.queued })
  })
  await supervisor.ready()

  const [worker] = supervisor.inspect()
  t.alike(
    {
      name: worker?.name,
      state: worker?.state,
      deps: worker?.deps,
      lives: worker?.lives,
      details: worker?.details
    },
    {
      name: 'worker',
      state: 'running',
      deps: [],
      lives: 1,
      details: { queued: 3 }
    }
  )
  await supervisor.close()
})

test('advanced reload is an explicit PoC stub', async (t) => {
  const supervisor = new Supervisor()
  await t.exception(
    supervisor.reload('worker'),
    /reload is not implemented in this PoC/
  )
})

function nextEvent(
  supervisor: Supervisor,
  predicate: (event: SupervisorEvent) => boolean
) {
  return new Promise<SupervisorEvent>((resolve) => {
    const unsubscribe = supervisor.onEvent((event) => {
      if (!predicate(event)) return
      unsubscribe()
      resolve(event)
    })
  })
}
