import assert from 'node:assert/strict'
import test from 'node:test'
import {
  applyAgentProfile,
  applyToolConfigs,
  CODING_INSTRUCTIONS,
  STOCK_BIOS
} from '../../dist/lib/runtime/agent-profile.js'

const profile = { instructions: CODING_INSTRUCTIONS, reasoning: 'enabled', ctxSize: 16384 }

test('a stock bio takes the default instructions and only changed fields are sent', async () => {
  const engine = fakeEngine()
  const agent = { id: 'a1', bio: STOCK_BIOS[1], reasoning: 'enabled', ctxSize: 8192 }

  const changed = await applyAgentProfile(engine, { meshId: 'm', agent, profile })

  assert.deepEqual(changed, { bio: CODING_INSTRUCTIONS, ctxSize: 16384 })
  assert.deepEqual(engine.calls, [{ agentId: 'a1', meshId: 'm', config: changed }])
})

test('a bio someone wrote is left alone unless qvac.config sets instructions', async () => {
  const engine = fakeEngine()
  const agent = { id: 'a1', bio: 'You review Rust code only.', reasoning: 'enabled' }

  const kept = await applyAgentProfile(engine, { meshId: 'm', agent, profile })
  assert.deepEqual(kept, { ctxSize: 16384 })

  const forced = await applyAgentProfile(engine, {
    meshId: 'm',
    agent,
    profile: { instructions: 'Be terse.' },
    sources: { 'core.agent.instructions': 'config' }
  })
  assert.deepEqual(forced, { bio: 'Be terse.' })
})

test('core.agent.name renames the agent', async () => {
  const engine = fakeEngine()
  const agent = { id: 'a1', bio: CODING_INSTRUCTIONS, name: 'QV.AC' }
  const named = { instructions: CODING_INSTRUCTIONS, name: 'Coder' }

  assert.deepEqual(await applyAgentProfile(engine, { meshId: 'm', agent, profile: named }), {
    name: 'Coder'
  })
})

test('nothing to change sends nothing', async () => {
  const engine = fakeEngine()
  const agent = { id: 'a1', bio: CODING_INSTRUCTIONS, reasoning: 'enabled', ctxSize: 16384 }

  assert.deepEqual(await applyAgentProfile(engine, { meshId: 'm', agent, profile }), {})
  assert.deepEqual(engine.calls, [])
})

test('leaving a project puts the stock bio back on an agent that had ours', async () => {
  const engine = fakeEngine()
  const agent = { id: 'a1', bio: CODING_INSTRUCTIONS }

  const changed = await applyAgentProfile(engine, { meshId: 'm', agent, profile: {} })

  assert.deepEqual(changed, { bio: STOCK_BIOS[0] })
})

function fakeEngine() {
  return {
    calls: [],
    updateAgent(call) {
      this.calls.push(call)
      return Promise.resolve()
    }
  }
}

test('an agent on an earlier version of the coding instructions gets the current one', async () => {
  const engine = fakeEngine()
  const earlier = CODING_INSTRUCTIONS.split('\n').slice(0, 3).join('\n') + '\n1. Old step.'
  const agent = { id: 'a1', bio: earlier, reasoning: 'enabled', ctxSize: 16384 }

  const changed = await applyAgentProfile(engine, { meshId: 'm', agent, profile })

  assert.deepEqual(changed, { bio: CODING_INSTRUCTIONS })
})

test('disabled toolsets are sent only when the list differs', async () => {
  const engine = fakeEngine()
  const agent = { id: 'a1', bio: CODING_INSTRUCTIONS, disabledToolsets: ['exec'] }

  const same = await applyAgentProfile(engine, {
    meshId: 'm',
    agent,
    profile: { instructions: CODING_INSTRUCTIONS, disabledToolsets: ['exec'] }
  })
  assert.deepEqual(same, {})

  const more = await applyAgentProfile(engine, {
    meshId: 'm',
    agent,
    profile: { instructions: CODING_INSTRUCTIONS, disabledToolsets: ['exec', 'web'] }
  })
  assert.deepEqual(more, { disabledToolsets: ['exec', 'web'] })
})

test('a skills list in qvac.config is sent as the whole list', async () => {
  const engine = fakeEngine()
  const agent = { id: 'a1', bio: CODING_INSTRUCTIONS, enabledSkills: ['qvac-plugins'] }

  const none = await applyAgentProfile(engine, {
    meshId: 'm',
    agent,
    profile: { instructions: CODING_INSTRUCTIONS, enabledSkills: [] }
  })
  assert.deepEqual(none, { enabledSkills: [] })
})

test('a default adds to the toolsets the user hid, and a config list is the whole list', async () => {
  const agent = { id: 'a1', bio: CODING_INSTRUCTIONS, disabledToolsets: ['web'] }
  const profile = { instructions: CODING_INSTRUCTIONS, disabledToolsets: ['exec'] }

  const added = await applyAgentProfile(fakeEngine(), { meshId: 'm', agent, profile })
  assert.deepEqual(added, { disabledToolsets: ['web', 'exec'] })

  const replaced = await applyAgentProfile(fakeEngine(), {
    meshId: 'm',
    agent,
    profile: { ...profile, disabledToolsets: [] },
    sources: { 'core.agent.disabledToolsets': 'config' }
  })
  assert.deepEqual(replaced, { disabledToolsets: [] })
})

test('tool settings from qvac.config are written only where Core holds something else', async () => {
  const set = []
  const engine = {
    listToolConfigs: () =>
      Promise.resolve({
        configs: [
          { toolName: 'edit_file', settings: { forms: 'all' } },
          { toolName: 'read_file', settings: { lines: 100 }, deletedAt: 1 }
        ]
      }),
    setToolConfigs: (call) => {
      set.push(call)
      return Promise.resolve(call)
    }
  }
  const agent = { id: 'a1' }

  const changed = await applyToolConfigs(engine, {
    meshId: 'm',
    agent,
    configs: { edit_file: { forms: 'all' }, read_file: { lines: 100 }, grep: { context: 2 } }
  })

  assert.deepEqual(changed, ['read_file', 'grep'], 'a deleted row is written again')
  assert.deepEqual(set, [
    { agentId: 'a1', meshId: 'm', toolName: 'read_file', settings: { lines: 100 } },
    { agentId: 'a1', meshId: 'm', toolName: 'grep', settings: { context: 2 } }
  ])
})
