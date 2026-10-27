import assert from 'node:assert/strict'
import test from 'node:test'
import { codingRun } from '../../dist/lib/core/coding-run.js'

function fixture() {
  const captured = {}
  const options = {
    harness: {
      completion: (request) => {
        captured.run = request
        return request
      }
    },
    Agent: {
      delegateTool: (host, base, config) => {
        captured.base = base
        captured.delegate = config
        return { name: 'delegate' }
      }
    },
    ExternalAgents: {
      targets: (config) => {
        captured.external = config
        return config.targets.map((t) => ({
          name: t.name,
          run: (request, signal) => {
            captured.signal = signal
            request.onEvent?.({ type: 'message', text: 'working' })
            return Promise.resolve({ status: 'answered', text: 'done' })
          }
        }))
      }
    },
    model: 'test-model',
    projectDir: '/project',
    dataDir: '/state/agents',
    task: 'Review this change',
    targets: [{ name: 'codex', command: '/bin/codex', protocol: 'codex' }]
  }

  return { captured, options }
}

test('composition includes delegate and the reviewer; defaults stay offline and deny writes', async () => {
  const { captured, options } = fixture()
  codingRun(options)
  assert.equal(captured.run.tools[0].name, 'delegate')
  assert.equal(captured.run.agent.plan, true)
  assert.equal(captured.run.agent.handoffs[0].id, 'reviewer')
  assert.deepEqual(captured.base.grantedWriteDirs, [])
  assert.equal(captured.base.approve, undefined)
  assert.equal(captured.external, undefined)
  assert.equal(await captured.run.approve({}), false)
})

test('user login is an explicit per-target opt-in', () => {
  const { options } = fixture()
  options.targets[0].login = 'user'
  assert.throws(() => codingRun({ ...options, network: 'on' }), /Opt in/)
  options.targets[0].userLoginApproved = true
  assert.doesNotThrow(() => codingRun({ ...options, network: 'on' }))
})

test('plan mode has no external targets or write roots', () => {
  const { captured, options } = fixture()
  codingRun({ ...options, network: 'on', planMode: true })
  assert.equal(captured.external, undefined)
  assert.deepEqual(captured.delegate.targets, [])
  assert.deepEqual(captured.run.grantedWriteDirs, [])
})

test('target events reach the host and retain the request listener and cancellation signal', async () => {
  const { captured, options } = fixture()
  const events = []
  const own = []
  codingRun({ ...options, network: 'on', onEvent: (e) => events.push(e) })
  const signal = new AbortController().signal
  await captured.delegate.targets[0].run({ runId: 'r', onEvent: (e) => own.push(e) }, signal)
  assert.equal(captured.signal, signal)
  assert.equal(events[0].target, 'codex')
  assert.equal(events[0].runId, 'r')
  assert.equal(own.length, 1)
  assert.equal(captured.external.targets[0].login, 'isolated')
  assert.deepEqual(captured.delegate.read, [])
})
