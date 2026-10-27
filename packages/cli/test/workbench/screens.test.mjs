import test from 'node:test'
import assert from 'node:assert/strict'
import { screens, summary, contextOptions } from '../../dist/product/screens.js'

const catalogSkills = [
  {
    name: 'web',
    displayName: 'Web',
    emoji: '🌐',
    description: 'Search and read the web.',
    status: 'ready',
    tools: ['web_search'],
    setup: { routes: [] }
  },
  {
    name: 'github',
    displayName: 'GitHub',
    emoji: '🐙',
    description: 'Issues and pull requests.',
    status: 'needs-setup',
    tools: ['gh_issue'],
    setup: {
      summary: 'Paste a token.',
      routes: [
        {
          kind: 'token',
          label: 'Personal token',
          provider: 'github',
          credentialKey: 'GITHUB_TOKEN',
          fields: [{ key: 'GITHUB_TOKEN', label: 'Token', secret: true, required: true }],
          satisfied: false
        }
      ]
    }
  },
  { name: 'notes', description: 'Local notes.', status: 'ready' },
  { name: 'music', displayName: 'Music', status: 'unsupported' }
]

function fakeEngine(overrides = {}) {
  const calls = []
  const record = (name, result) => (input) => {
    calls.push([name, input])
    return Promise.resolve(typeof result === 'function' ? result(input) : result)
  }

  return {
    calls,
    named: (name) => calls.filter(([n]) => n === name).map(([, input]) => input),
    skillCatalog: record('skillCatalog', { skills: catalogSkills }),
    listManagedSkills: record('listManagedSkills', {
      skills: [{ name: 'web', origin: 'overlay', overridesBase: true }]
    }),
    writeSkillFile: record('writeSkillFile', { ok: true }),
    pushSkillSecret: record('pushSkillSecret', { ok: true }),
    configSet: record('configSet', { ok: true }),
    skills: record('skills', { skills: [] }),
    updateAgent: record('updateAgent', (input) => ({ id: input.agentId, ...input.config })),
    getConfig: record('getConfig', { thinkingEnabled: true, ctxSize: 8192, delegation: {} }),
    listModels: record('listModels', { models: [{ name: 'Qwen', contextLength: 40960 }] }),
    tools: record('tools', {
      tools: [
        { name: 'web_search', toolset: 'web-search', promptChars: 400 },
        { name: 'read_file', toolset: 'files', promptChars: 300 },
        { name: 'write_file', toolset: 'files', promptChars: 500 },
        { name: 'custom_thing', toolset: 'custom', promptChars: 40 }
      ]
    }),
    listApprovalRules: record('listApprovalRules', {
      rules: [
        {
          id: 'r1',
          toolName: 'write_file',
          resourceKind: 'path',
          resourcePattern: '/src/**',
          decision: 'allow',
          createdAt: 1_700_000_000_000,
          memberId: 'me'
        }
      ],
      ourMemberId: 'me'
    }),
    listChunks: record('listChunks', (input) =>
      input.type === 'compaction'
        ? { chunks: [{ id: 'c1', type: 'compaction' }] }
        : {
            chunks: [
              {
                runId: 'run-1',
                runStatus: { state: 'completed', metrics: { ctxSize: 1000, cacheTokens: 100 } }
              },
              { runId: 'run-2', runStatus: { state: 'running' } },
              {
                runId: 'run-2',
                runStatus: {
                  state: 'completed',
                  metrics: {
                    ctxSize: 8192,
                    cacheTokens: 4096,
                    totalTokens: 300,
                    tokensPerSecond: 21.456,
                    timeToFirstToken: 812.4,
                    stopReason: 'eos',
                    usage: {
                      systemPrompt: 1000,
                      agentInstructions: 200,
                      activeSkills: 300,
                      tools: 1500
                    }
                  }
                }
              }
            ]
          }
    ),
    compactChat: record('compactChat', { compacted: true, foldedTurns: 6, reason: null }),
    getChat: record('getChat', { id: 'chat-1', ragEnabled: true, webSearchEnabled: false }),
    listKnowledge: record('listKnowledge', {
      knowledge: [
        {
          id: 'k1',
          fileName: 'spec.pdf',
          mimeType: 'application/pdf',
          byteLength: 2_400_000,
          createdAt: 1_700_000_000_000
        }
      ]
    }),
    removeKnowledge: record('removeKnowledge', { ok: true }),
    setChatRagEnabled: record('setChatRagEnabled', {}),
    setChatWebSearchEnabled: record('setChatWebSearchEnabled', {}),
    listToolActivity: record('listToolActivity', {
      activities: [
        {
          id: 'a1',
          toolName: 'write_file',
          decision: 'allow',
          effect: 'write',
          resource: { kind: 'path', label: 'src/a.js' },
          at: Date.now() - 120_000,
          seq: 4
        }
      ]
    }),
    ...overrides
  }
}

function context(agent = {}, overrides = {}) {
  const engine = fakeEngine(overrides)
  let refreshed = 0
  const ctx = {
    engine,
    meshId: 'mesh-1',
    chatId: 'chat-1',
    agent: { id: 'agent-1', name: 'QV.AC', modelName: 'Qwen', ...agent },
    refreshAgent: () => {
      refreshed++
      return Promise.resolve(ctx.agent)
    },
    get refreshed() {
      return refreshed
    }
  }

  return ctx
}

const row = (rows, id) => rows.find((r) => r.id === id)

test('skills rows reflect scope all and status badges', async () => {
  const ctx = context({ skillsScope: 'all' })
  const { rows } = await screens.skills.load(ctx)
  assert.deepEqual(ctx.engine.named('skillCatalog')[0], { agentId: 'agent-1', modelName: 'Qwen' })
  assert.equal(rows.length, 4)
  assert.equal(row(rows, 'web').label, '🌐 Web')
  assert.equal(row(rows, 'notes').label, 'notes')
  assert.ok(rows.every((r) => r.state === 'on'))
  assert.deepEqual(row(rows, 'web').badge, { text: 'ready', color: 'green' })
  assert.deepEqual(row(rows, 'github').badge, { text: 'needs-setup', color: 'red' })
  assert.equal(row(rows, 'music').badge.color, 'muted')
  assert.equal(row(rows, 'github').badge.text, 'needs-setup')
})

test('skills accept an unwrapped catalog array', async () => {
  const ctx = context(
    { skillsScope: 'selected', enabledSkills: ['notes'] },
    { skillCatalog: () => Promise.resolve(catalogSkills) }
  )
  const { rows } = await screens.skills.load(ctx)
  assert.equal(row(rows, 'notes').state, 'on')
  assert.equal(row(rows, 'web').state, 'off')
})

test('toggling a skill off from scope all selects every other ready skill', async () => {
  const ctx = context({ skillsScope: 'all' })
  await screens.skills.toggle(ctx, { id: 'web' })
  assert.deepEqual(ctx.engine.named('updateAgent'), [
    {
      agentId: 'agent-1',
      meshId: 'mesh-1',
      config: { enabledSkills: ['notes'], skillsScope: 'selected' }
    }
  ])
  assert.equal(ctx.refreshed, 1)
})

test('toggling within scope selected adds and removes', async () => {
  const ctx = context({ skillsScope: 'selected', enabledSkills: ['web'] })
  await screens.skills.toggle(ctx, { id: 'notes' })
  ctx.agent.enabledSkills = ['web', 'notes']
  await screens.skills.toggle(ctx, { id: 'web' })
  assert.deepEqual(
    ctx.engine.named('updateAgent').map((c) => c.config),
    [
      { enabledSkills: ['web', 'notes'], skillsScope: 'selected' },
      { enabledSkills: ['notes'], skillsScope: 'selected' }
    ]
  )
})

test('scope action flips between all and selected', async () => {
  const ctx = context({ skillsScope: 'all' })
  const scope = screens.skills.actions.find((a) => a.key === 'a')
  await scope.run(ctx)
  ctx.agent.skillsScope = 'selected'
  await scope.run(ctx)
  assert.deepEqual(
    ctx.engine.named('updateAgent').map((c) => c.config),
    [{ enabledSkills: ['web', 'notes'], skillsScope: 'selected' }, { skillsScope: 'all' }]
  )
})

test('opening a skill with a token route prompts and pushes the secret', async () => {
  const ctx = context()
  const { prompt } = await screens.skills.open(ctx, { id: 'github' })
  assert.equal(prompt.secret, true)
  assert.match(prompt.label, /GitHub.*Personal token: Token/)
  await prompt.submit('ghp_123')
  assert.deepEqual(ctx.engine.named('pushSkillSecret'), [
    { agentId: 'agent-1', skillName: 'github', values: [{ key: 'GITHUB_TOKEN', value: 'ghp_123' }] }
  ])
  assert.deepEqual(ctx.engine.named('skills'), [
    { refresh: true, agentId: 'agent-1', modelName: 'Qwen', meshId: 'mesh-1' }
  ])
  assert.equal(ctx.engine.named('configSet').length, 0)
})

test('a failed push falls back to configSet', async () => {
  const ctx = context(
    {},
    {
      pushSkillSecret: () => Promise.reject(new Error('no harness'))
    }
  )
  const { prompt } = await screens.skills.open(ctx, { id: 'github' })
  await prompt.submit('ghp_123')
  assert.deepEqual(ctx.engine.named('configSet'), [
    { key: 'skills.agent-1.GITHUB_TOKEN', value: 'ghp_123' }
  ])
  assert.equal(ctx.engine.named('skills').length, 1)
})

test('opening a ready skill shows details with origin', async () => {
  const ctx = context()
  const { title, lines } = await screens.skills.open(ctx, { id: 'web' })
  assert.equal(title, '🌐 Web')
  const text = lines.join('\n')
  assert.match(text, /Search and read the web/)
  assert.match(text, /Tools: web_search/)
  assert.match(text, /Origin: overlay \(overrides base\)/)
})

test('new skill writes a starter SKILL.md', async () => {
  const ctx = context()
  const { prompt } = screens.skills.actions.find((a) => a.key === 'n').run(ctx)
  await prompt.submit('My Helper')
  const [write] = ctx.engine.named('writeSkillFile')
  assert.equal(write.name, 'my-helper')
  assert.match(write.content, /^---\nname: my-helper\ndescription: .+\n---\n/)
  await assert.rejects(prompt.submit('  '), /needs a name/)
})

test('refresh action asks the catalog for a fresh probe', async () => {
  const ctx = context()
  await screens.skills.actions.find((a) => a.key === 'r').run(ctx)
  assert.equal(ctx.engine.named('skillCatalog')[0].refresh, true)
})

test('tools rows group toolsets with token badges', async () => {
  const ctx = context({ disabledToolsets: ['files'] })
  const { rows } = await screens.tools.load(ctx)
  const files = row(rows, 'files')
  assert.equal(files.state, 'off')
  assert.equal(files.detail, 'read_file, write_file')
  assert.deepEqual(files.badge, { text: '~200 tok', color: 'muted' })
  assert.equal(row(rows, 'web-search').state, 'on')
  assert.ok(row(rows, 'custom'))
  assert.equal(row(rows, 'team').detail, 'no tools on this host')
})

test('toggling a toolset preserves unknown disabled ids', async () => {
  const ctx = context({ disabledToolsets: ['legacy-x', 'files'] })
  await screens.tools.toggle(ctx, { id: 'exec' })
  ctx.agent.disabledToolsets = ['legacy-x', 'files', 'exec']
  await screens.tools.toggle(ctx, { id: 'files' })
  assert.deepEqual(
    ctx.engine.named('updateAgent').map((c) => c.config),
    [
      { disabledToolsets: ['legacy-x', 'files', 'exec'] },
      { disabledToolsets: ['legacy-x', 'exec'] }
    ]
  )
})

test('permissions show approval mode and read-only rules', async () => {
  const ctx = context()
  const { rows, note } = await screens.permissions.load(ctx)
  assert.equal(rows[0].state, 'on')
  assert.match(rows[0].label, /off approves every call/)
  const rule = row(rows, 'rule:r1')
  assert.equal(rule.state, undefined)
  assert.equal(rule.detail, 'allow · path /src/** · no expiry')
  assert.equal(rule.badge.text, 'yours')
  assert.match(note.join(' '), /cannot be deleted/)
  const opened = await screens.permissions.open(ctx, rule)
  assert.ok(opened.lines.includes('Resource: path /src/**'))
})

test('approval mode flips ask and skip-all', async () => {
  const ctx = context()
  await screens.permissions.toggle(ctx, { id: 'approval' })
  ctx.agent.approvalMode = 'skip-all'
  assert.equal((await screens.permissions.load(ctx)).rows[0].state, 'off')
  await screens.permissions.toggle(ctx, { id: 'approval' })
  await screens.permissions.toggle(ctx, { id: 'rule:r1' })
  assert.deepEqual(
    ctx.engine.named('updateAgent').map((c) => c.config),
    [{ approvalMode: 'skip-all' }, { approvalMode: 'ask' }]
  )
})

test('agent rows fall back to app defaults', async () => {
  const ctx = context({ bio: 'x'.repeat(200) })
  const { rows } = await screens.agent.load(ctx)
  assert.equal(row(rows, 'thinking').state, 'on')
  assert.deepEqual(row(rows, 'thinking').badge, { text: 'default', color: 'muted' })
  assert.match(row(rows, 'ctx').detail, /8,192 tokens \(default\)/)
  assert.ok(row(rows, 'bio').detail.length <= 70)
  assert.equal(row(rows, 'approval').detail, 'asks before writes')
})

test('thinking toggle flips the effective reasoning', async () => {
  const ctx = context()
  await screens.agent.toggle(ctx, { id: 'thinking' })
  ctx.agent.reasoning = 'disabled'
  await screens.agent.toggle(ctx, { id: 'thinking' })
  assert.deepEqual(
    ctx.engine.named('updateAgent').map((c) => c.config),
    [{ reasoning: 'disabled' }, { reasoning: 'enabled' }]
  )
})

test('agent prompts submit name, instructions and context', async () => {
  const ctx = context({ ctxSize: 16384 })
  const name = (await screens.agent.open(ctx, { id: 'name' })).prompt
  assert.equal(name.value, 'QV.AC')
  await name.submit(' Coder ')
  await (await screens.agent.open(ctx, { id: 'bio' })).prompt.submit('Be terse.')
  const size = (await screens.agent.open(ctx, { id: 'ctx' })).prompt
  assert.equal(size.value, '16384')
  assert.match(size.label, /32768, 40960, or default/)
  await size.submit('32k')
  await size.submit('default')
  await assert.rejects(size.submit('lots'), /not a context size/)
  assert.deepEqual(
    ctx.engine.named('updateAgent').map((c) => c.config),
    [{ name: 'Coder' }, { bio: 'Be terse.' }, { ctxSize: 32768 }, { clearCtxSize: true }]
  )
})

test('context options cap at the model window', () => {
  assert.deepEqual(contextOptions(undefined), [4096, 8192, 16384, 32768, 65536, 131072])
  assert.deepEqual(contextOptions(16384), [4096, 8192, 16384])
  assert.deepEqual(contextOptions(262144), [4096, 8192, 16384, 32768, 65536, 131072])
})

test('usage reads the latest completed run', async () => {
  const ctx = context()
  const { rows } = await screens.usage.load(ctx)
  assert.deepEqual(
    ctx.engine.named('listChunks').map((c) => c.type),
    ['run-status', 'compaction']
  )
  assert.equal(row(rows, 'window').detail, '8,192 tokens')
  assert.equal(row(rows, 'used').detail, '4,096 tokens (50%)')
  assert.equal(row(rows, 'systemPrompt').detail, '1,000 tokens')
  assert.equal(row(rows, 'conversation').detail, '1,096 tokens')
  assert.equal(row(rows, 'speed').detail, '21.5 tok/s')
  assert.equal(row(rows, 'ttft').detail, '812 ms')
  assert.equal(row(rows, 'stop').detail, 'eos')
  assert.equal(row(rows, 'compactions').detail, '1')
  assert.ok(rows.every((r) => r.state === undefined))
})

test('usage copes with no runs and no chat', async () => {
  const ctx = context({}, { listChunks: () => Promise.resolve({}) })
  const empty = await screens.usage.load(ctx)
  assert.equal(empty.rows.length, 1)
  assert.match(empty.note[0], /No completed run/)
  ctx.chatId = null
  assert.deepEqual((await screens.usage.load(ctx)).rows, [])
})

test('compact action reports the fold', async () => {
  const ctx = context()
  const compact = screens.usage.actions.find((a) => a.key === 'c')
  assert.deepEqual(await compact.run(ctx), {
    title: 'Compaction',
    lines: ['Folded 6 turns into a summary.']
  })
  assert.deepEqual(ctx.engine.named('compactChat'), [{ chatId: 'chat-1', meshId: 'mesh-1' }])
  ctx.engine.compactChat = () => Promise.resolve({ compacted: false, reason: 'below-floor' })
  assert.deepEqual((await compact.run(ctx)).lines, ['Nothing was compacted: below-floor'])
})

test('knowledge rows, flags and guarded removal', async () => {
  const ctx = context()
  const { rows } = await screens.knowledge.load(ctx)
  assert.equal(row(rows, 'rag').state, 'on')
  assert.equal(row(rows, 'web').state, 'off')
  const file = row(rows, 'file:k1')
  assert.equal(file.label, 'spec.pdf')
  assert.equal(file.badge.text, '2 MB')
  await screens.knowledge.toggle(ctx, row(rows, 'rag'))
  await screens.knowledge.toggle(ctx, row(rows, 'web'))
  assert.deepEqual(ctx.engine.named('setChatRagEnabled'), [
    { chatId: 'chat-1', meshId: 'mesh-1', enabled: false }
  ])
  assert.deepEqual(ctx.engine.named('setChatWebSearchEnabled'), [
    { chatId: 'chat-1', meshId: 'mesh-1', enabled: true }
  ])
  const { prompt } = screens.knowledge.open(ctx, file)
  assert.match(prompt.label, /spec\.pdf.*type yes to remove/)
  await prompt.submit('no')
  await prompt.submit('y')
  assert.equal(ctx.engine.named('removeKnowledge').length, 0)
  await prompt.submit(' YES ')
  const [removed] = ctx.engine.named('removeKnowledge')
  assert.equal(removed.knowledgeId, 'k1')
  assert.equal(removed.meshId, 'mesh-1')
  assert.equal(typeof removed.at, 'number')
})

test('activity lists recent tool calls', async () => {
  const ctx = context()
  const { rows } = await screens.activity.load(ctx)
  assert.deepEqual(ctx.engine.named('listToolActivity'), [
    { agentId: 'agent-1', meshId: 'mesh-1', limit: 30 }
  ])
  assert.equal(rows[0].label, 'write_file')
  assert.equal(rows[0].detail, '2m ago · allow/write · src/a.js')
  const empty = await screens.activity.load(
    context({}, { listToolActivity: () => Promise.resolve({}) })
  )
  assert.deepEqual(empty.rows, [])
})

test('load surfaces engine errors', async () => {
  const ctx = context(
    {},
    {
      tools: () => Promise.reject(new Error('core down'))
    }
  )
  await assert.rejects(screens.tools.load(ctx), /core down/)
})

test('summary describes the agent in one line', () => {
  assert.equal(
    summary({
      skillsScope: 'selected',
      enabledSkills: Array(9).fill('s'),
      disabledToolsets: ['a', 'b'],
      approvalMode: 'ask',
      reasoning: 'enabled'
    }),
    '9 skills · 2 toolsets off · asks before writes · thinking on'
  )
  assert.equal(summary({}), '0 skills · 0 toolsets off · asks before writes · thinking default')
  assert.equal(
    summary({
      skillsScope: 'all',
      disabledToolsets: ['x'],
      approvalMode: 'skip-all',
      reasoning: 'disabled'
    }),
    'all skills · 1 toolset off · auto-approves · thinking off'
  )
})
