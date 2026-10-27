import assert from 'node:assert/strict'
import test from 'node:test'
import { setUp } from '../../dist/cli/commands/serve/setup.js'

function host({ invite = null } = {}) {
  const calls = []
  const engine = {
    getConfig: async () => ({ onboardingCompleted: false }),
    setConfig: async (config) => calls.push(['setConfig', config]),
    updateMember: async (input) => calls.push(['updateMember', input]),
    createWorkspace: async () => calls.push(['createWorkspace']),
    account: async () => ({ meshId: 'account' }),
    renameDevice: async (input) => calls.push(['renameDevice', input.config.name]),
    previewMeshInvite: async () => invite
  }

  return { engine, calls, deviceName: 'mac', configure: async () => calls.push(['configure']) }
}

const io = (answers = []) => ({
  interactive: answers.length > 0,
  line() {},
  note() {},
  ask: async (question, { optional } = {}) => {
    const answer = answers.shift()
    return answer === undefined && optional ? '' : answer
  }
})

test('with nothing to ask in, setup sets the device up on its own: no workspace, no link', async () => {
  const h = host()
  const result = await setUp(h, { version: 'x' }, io())

  assert.deepEqual(result, { created: false })
  assert.deepEqual(
    h.calls.filter(([name]) => name === 'createWorkspace'),
    []
  )
  assert.deepEqual(h.calls.at(-1), ['setConfig', { onboardingCompleted: true }])
})

test('asked, enter alone sets it up on its own with the name and device given', async () => {
  const h = host()
  await setUp(h, { version: 'x' }, io(['', 'Ada', 'studio']))

  assert.deepEqual(
    h.calls.filter(([name]) => name === 'createWorkspace'),
    []
  )
  assert.deepEqual(h.calls[0], ['updateMember', { config: { name: 'Ada' } }])
  assert.ok(h.calls.some(([name, value]) => name === 'renameDevice' && value === 'studio'))
})

test('a workspace link at the pairing prompt is turned back to after setup', async () => {
  const h = host({ invite: { memberInvite: true, inviterName: 'Bo' } })
  await assert.rejects(
    setUp(h, { version: 'x' }, io(['qvac://workspace/abc'])),
    /workspace link\. Set this device up first, then: qvac workspace join/
  )
})

test('serve takes one way to join or create, and --create needs a name when nothing can ask', async () => {
  await assert.rejects(
    setUp(host(), { version: 'x', create: true, join: 'qvac://w' }, io()),
    /pass one of --create, --join/
  )
  await assert.rejects(
    setUp(host(), { version: 'x', create: true }, io()),
    /missing --account-name/
  )
})
