import type { Capabilities } from '@qvac/core/client'
import type { Agent } from '../lib/types.js'
import type { Screen, ScreenContext, ScreenPanel, ScreenRow } from './screen.js'
import type { Chunk } from './transcript.js'
type Skill = NonNullable<Awaited<ReturnType<Capabilities['skillCatalog']>>['skills']>[number]
type ManagedSkill = NonNullable<
  Awaited<ReturnType<Capabilities['listManagedSkills']>>['skills']
>[number]
type Rule = NonNullable<Awaited<ReturnType<Capabilities['listApprovalRules']>>['rules']>[number]
interface UsageMetrics {
  cacheTokens: number | null
  ctxSize: number | null
  tokensPerSecond: number | null
  timeToFirstToken: number | null
  stopReason?: string
  usage?: Record<string, number>
}
import { bytes } from './theme.js'

// Manage screens: data plus Core calls, rendered by the app (see screen.mjs).
const TOOLSETS = [
  'web-search',
  'knowledge',
  'files',
  'exec',
  'http-request',
  'mcp-call',
  'image',
  'music',
  'coding',
  'team'
]
const CONTEXT_OPTIONS = [4096, 8192, 16384, 32768, 65536, 131072]
const RED = new Set(['needs-setup', 'disconnected'])
const APPROVAL_LABEL = 'Ask before changes (off approves every call)'

const short = (text: unknown, max = 60) => {
  const line = String(text ?? '')
    .replace(/\s+/g, ' ')
    .trim()
  return line.length > max ? line.slice(0, max - 1) + '…' : line
}
const tokens = (n: unknown) =>
  typeof n === 'number' && Number.isFinite(n) ? n.toLocaleString('en-US') : '—'
const when = (at: string | number | Date) =>
  at ? new Date(at).toISOString().slice(0, 16).replace('T', ' ') : '—'
const ago = (at: number, now = Date.now()) => {
  const s = Math.max(0, Math.round((now - at) / 1000))
  if (s < 60) {
    return `${s}s ago`
  }

  if (s < 3600) {
    return `${Math.floor(s / 60)}m ago`
  }

  if (s < 86400) {
    return `${Math.floor(s / 3600)}h ago`
  }

  return `${Math.floor(s / 86400)}d ago`
}
const slug = (name: string) =>
  String(name)
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')

async function update(
  ctx: ScreenContext,
  config: Parameters<Capabilities['updateAgent']>[0]['config']
) {
  const agent = await ctx.engine.updateAgent({ agentId: ctx.agent.id, meshId: ctx.meshId, config })
  await ctx.refreshAgent?.()
  return agent
}

// Core and the harness read a missing scope as selected, so this screen does too.
const scopeOf = (agent: Agent) => agent.skillsScope || 'selected'
const skillOn = (agent: Agent, name: string) =>
  scopeOf(agent) === 'all' || (agent.enabledSkills || []).includes(name)
function statusColor(status: string): NonNullable<ScreenRow['badge']>['color'] {
  if (status === 'ready') return 'green'
  return RED.has(status) ? 'red' : 'muted'
}

async function catalog(ctx: ScreenContext, { refresh = false } = {}) {
  const request: Parameters<Capabilities['skillCatalog']>[0] = {
    agentId: ctx.agent.id,
    modelName: ctx.agent.modelName
  }
  if (refresh) {
    request.refresh = true
  }

  const result = await ctx.engine.skillCatalog(request)

  return Array.isArray(result) ? (result as Skill[]) : result?.skills || []
}

const readyNames = (skills: Skill[]) =>
  skills.filter((s) => s.status === 'ready').map((s) => s.name)

// The first secret a token route still needs, if any.
function pendingSecret(skill: Skill) {
  for (const route of skill.setup?.routes || []) {
    if (route.kind !== 'token' || route.satisfied || !route.fields?.length) {
      continue
    }

    const field = route.fields.find((f) => f.secret) || route.fields[0]!

    return { route, field }
  }

  return null
}

async function pushSecret(
  ctx: ScreenContext,
  skillName: string,
  { key, value }: { key: string; value: string }
) {
  const { engine, agent, meshId } = ctx
  try {
    await engine.pushSkillSecret({ agentId: agent.id, skillName, values: [{ key, value }] })
  } catch {
    await engine.configSet({ key: `skills.${agent.id}.${key}`, value })
  }

  await engine.skills({ refresh: true, agentId: agent.id, modelName: agent.modelName, meshId })
}

function skillLines(skill: Skill, managed: ManagedSkill | undefined) {
  const lines = [skill.description || 'No description.', '']
  lines.push(`Status: ${skill.status || 'unknown'}`)
  if (managed) {
    lines.push(`Origin: ${managed.origin}${managed.overridesBase ? ' (overrides base)' : ''}`)
  }

  if (skill.tools?.length) {
    lines.push(`Tools: ${skill.tools.join(', ')}`)
  }

  if (skill.setup?.summary) {
    lines.push('', `Setup: ${skill.setup.summary}`)
  }

  for (const route of skill.setup?.routes || []) {
    lines.push(
      `  ${route.satisfied ? '✓' : '○'} ${route.label || route.kind} (${route.kind}${route.provider ? ' · ' + route.provider : ''})`
    )
    for (const field of route.fields || []) {
      lines.push(
        `      ${field.label || field.key}${field.secret ? ' · secret' : ''}${field.required ? ' · required' : ''}`
      )
    }

    for (const step of route.steps || []) {
      lines.push(`      ${step}`)
    }

    if (route.helpUrl) {
      lines.push(`      ${route.helpUrl}`)
    }
  }

  return lines
}

const starter = (name: string) =>
  `---\nname: ${name}\ndescription: Describe what this skill does and when the agent should use it.\n---\n\n# ${name}\n\nWrite the steps the agent should follow here.\n`

const skills: Screen = {
  title: 'Skills',
  hint: 'space toggle  enter details/setup  a scope  n new  r refresh',
  async load(ctx) {
    const list = await catalog(ctx)
    const all = scopeOf(ctx.agent) === 'all'
    return {
      rows: list.map((s) => ({
        id: s.name,
        label: [s.emoji, s.displayName || s.name].filter(Boolean).join(' '),
        detail: short(s.description, 60),
        state: skillOn(ctx.agent, s.name) ? 'on' : 'off',
        badge: { text: s.status || 'unknown', color: statusColor(s.status) }
      })),
      note: [
        all
          ? 'Scope: all skills are on. Turning one off switches to selected.'
          : 'Scope: only the selected skills are on.'
      ]
    }
  },
  async toggle(ctx, row) {
    if (scopeOf(ctx.agent) === 'all') {
      const others = readyNames(await catalog(ctx)).filter((n) => n !== row.id)
      return update(ctx, { enabledSkills: others, skillsScope: 'selected' })
    }

    const current = ctx.agent.enabledSkills || []
    const enabledSkills = current.includes(row.id)
      ? current.filter((n) => n !== row.id)
      : [...current, row.id]

    return update(ctx, { enabledSkills, skillsScope: 'selected' })
  },
  async open(ctx, row) {
    const skill = (await catalog(ctx)).find((s) => s.name === row.id)
    if (!skill) {
      throw new Error(`Skill ${row.id} is no longer in the catalog.`)
    }

    const pending = pendingSecret(skill)
    if (pending) {
      return {
        prompt: {
          label: `${skill.displayName || skill.name} · ${pending.route.label || 'token'}: ${pending.field.label || pending.field.key}`,
          secret: !!pending.field.secret,
          submit: (value) => pushSecret(ctx, skill.name, { key: pending.field.key, value })
        }
      }
    }

    const { skills: managed = [] } = await ctx.engine.listManagedSkills({ agentId: ctx.agent.id })

    return {
      title: [skill.emoji, skill.displayName || skill.name].filter(Boolean).join(' '),
      lines: skillLines(
        skill,
        managed.find((m) => m.name === skill.name)
      )
    }
  },
  actions: [
    {
      key: 'a',
      label: 'scope all/selected',
      async run(ctx) {
        if (scopeOf(ctx.agent) === 'selected') {
          return update(ctx, { skillsScope: 'all' })
        }

        const enabledSkills = ctx.agent.enabledSkills?.length
          ? ctx.agent.enabledSkills
          : readyNames(await catalog(ctx))

        return update(ctx, { enabledSkills, skillsScope: 'selected' })
      }
    },
    {
      key: 'n',
      label: 'new skill',
      run: (ctx) => ({
        prompt: {
          label: 'New skill name',
          async submit(value: string) {
            const name = slug(value)
            if (!name) {
              throw new Error('A skill needs a name.')
            }

            await ctx.engine.writeSkillFile({ name, content: starter(name), agentId: ctx.agent.id })
            await ctx.engine.skills({
              refresh: true,
              agentId: ctx.agent.id,
              modelName: ctx.agent.modelName,
              meshId: ctx.meshId
            })
          }
        }
      })
    },
    {
      key: 'r',
      label: 'refresh',
      run: async (ctx) => {
        await catalog(ctx, { refresh: true })
      }
    }
  ]
}

const tools: Screen = {
  title: 'Tools',
  hint: 'space toggle a toolset',
  async load(ctx) {
    const { tools: list = [] } = await ctx.engine.tools({})
    const off = new Set(ctx.agent.disabledToolsets || [])
    const ids = [
      ...new Set([
        ...TOOLSETS,
        ...list.map((t) => t.toolset).filter((id): id is string => typeof id === 'string' && !!id)
      ])
    ]
    return {
      rows: ids
        .map((id) => ({ id, members: list.filter((t) => t.toolset === id) }))
        .filter(({ id, members }) => members.length || TOOLSETS.includes(id))
        .map(({ id, members }) => ({
          id,
          label: id,
          detail: members.map((t) => t.name).join(', ') || 'no tools on this host',
          state: off.has(id) ? 'off' : 'on',
          badge: {
            text: `~${Math.round(members.reduce((n, t) => n + (t.promptChars || 0), 0) / 4)} tok`,
            color: 'muted'
          }
        })),
      note: ['Turning a toolset off removes its tools from the prompt and frees context.']
    }
  },
  toggle(ctx, row) {
    const current = ctx.agent.disabledToolsets || []
    const disabledToolsets = current.includes(row.id)
      ? current.filter((id) => id !== row.id)
      : [...current, row.id]

    return update(ctx, { disabledToolsets })
  }
}

const ruleDetail = (r: Rule) =>
  [
    r.decision,
    [r.resourceKind, r.resourcePattern].filter(Boolean).join(' ') || 'any resource',
    r.expiresAt ? `expires ${when(r.expiresAt)}` : 'no expiry'
  ].join(' · ')
const asks = (agent: Agent) => (agent.approvalMode || 'ask') === 'ask'
const flipApproval = (ctx: ScreenContext) =>
  update(ctx, { approvalMode: asks(ctx.agent) ? 'skip-all' : 'ask' })

const permissions: Screen = {
  title: 'Permissions',
  async load(ctx) {
    const { rules = [], ourMemberId } = await ctx.engine.listApprovalRules({ meshId: ctx.meshId })
    return {
      rows: [
        { id: 'approval', label: APPROVAL_LABEL, state: asks(ctx.agent) ? 'on' : 'off' },
        ...(rules ?? []).map((r) => ({
          id: `rule:${r.id}`,
          label: r.toolName || 'any tool',
          detail: ruleDetail(r),
          badge:
            r.memberId && r.memberId === ourMemberId
              ? { text: 'yours', color: 'teal' as const }
              : undefined
        }))
      ],
      note: [
        'Rules are created when you answer a with always on an approval request.',
        'They cannot be deleted from here yet: Core has no route for it.'
      ]
    }
  },
  toggle(ctx, row: { id: string }) {
    if (row.id === 'approval') {
      return flipApproval(ctx)
    }
    return undefined
  },
  async open(ctx, row: { id: string }) {
    if (!row.id.startsWith('rule:')) return
    const { rules = [] } = await ctx.engine.listApprovalRules({ meshId: ctx.meshId })
    const r = (rules ?? []).find((x) => `rule:${x.id}` === row.id)
    if (!r) {
      throw new Error('That rule no longer exists.')
    }

    return {
      title: `Rule · ${r.toolName || 'any tool'}`,
      lines: [
        `Decision: ${r.decision}`,
        `Tool: ${r.toolName || 'any'}`,
        `Resource: ${r.resourceKind || 'any'} ${r.resourcePattern || ''}`.trim(),
        `Effect: ${r.effect || 'any'}`,
        `Agent: ${r.agentId || 'all agents'}`,
        `Created: ${when(r.createdAt)}`,
        `Expires: ${r.expiresAt ? when(r.expiresAt) : 'never'}`
      ]
    }
  }
}

// Core's model-context.ts is TypeScript, so a local list capped by the model's window stands in.
export const contextOptions = (max: number = 0) =>
  max > 0
    ? [
        ...CONTEXT_OPTIONS.filter((n) => n <= max),
        ...(CONTEXT_OPTIONS.includes(max) || max > CONTEXT_OPTIONS.at(-1)! ? [] : [max])
      ]
    : CONTEXT_OPTIONS

function parseContext(value: string) {
  const text = String(value).trim().toLowerCase()
  if (!text || text === 'default') {
    return { clearCtxSize: true }
  }

  const n = text.endsWith('k') ? Number(text.slice(0, -1)) * 1024 : Number(text)
  if (!Number.isInteger(n) || n <= 0) {
    throw new Error(`"${value}" is not a context size.`)
  }

  return { ctxSize: n }
}

const REASONING: Record<string, boolean> = { enabled: true, disabled: false }
const thinkingOn = (agent: Agent, config: Awaited<ReturnType<Capabilities['getConfig']>>) =>
  REASONING[agent.reasoning || ''] ?? !!config.thinkingEnabled

const AGENT_OPENERS: Record<string, (ctx: ScreenContext) => ScreenPanel | Promise<ScreenPanel>> = {
  name: (ctx) => ({
    prompt: {
      label: 'Agent name',
      value: ctx.agent.name || '',
      submit: async (v: string) => {
        if (!v.trim()) throw new Error('A name cannot be empty.')
        return update(ctx, { name: v.trim() })
      }
    }
  }),
  bio: (ctx) => ({
    prompt: {
      label: 'Instructions',
      value: ctx.agent.bio || '',
      submit: (v) => update(ctx, { bio: v })
    }
  }),
  ctx: async (ctx) => {
    const { models = [] } = await ctx.engine.listModels({})
    const model = (models ?? []).find((m) => m.name === ctx.agent.modelName)
    const max =
      model && 'contextLength' in model && typeof model.contextLength === 'number'
        ? model.contextLength
        : 0
    return {
      prompt: {
        label: `Context size (${contextOptions(max).join(', ')}, or default)`,
        value: ctx.agent.ctxSize ? String(ctx.agent.ctxSize) : '',
        submit: async (v) => update(ctx, parseContext(v))
      }
    }
  },
  model: (ctx) => ({
    title: 'Model',
    lines: [ctx.agent.modelName || 'No model set.', '', 'Pick another model from the model picker.']
  })
}

const agentScreen: Screen = {
  title: 'Agent',
  hint: 'enter edit  space toggle',
  async load(ctx) {
    const a = ctx.agent
    const config = await ctx.engine.getConfig({})
    const inherit = !a.reasoning || a.reasoning === 'inherit'
    return {
      rows: [
        { id: 'name', label: 'Name', detail: a.name || '—' },
        { id: 'bio', label: 'Instructions', detail: short(a.bio, 70) || '—' },
        { id: 'model', label: 'Model', detail: a.modelName || '—' },
        {
          id: 'thinking',
          label: 'Thinking',
          state: thinkingOn(a, config) ? 'on' : 'off',
          badge: inherit ? { text: 'default', color: 'muted' } : undefined
        },
        {
          id: 'ctx',
          label: 'Context size',
          detail: a.ctxSize
            ? `${tokens(a.ctxSize)} tokens`
            : `${config.ctxSize ? tokens(config.ctxSize) + ' tokens' : 'app'} (default)`
        },
        {
          id: 'approval',
          label: 'Approval mode',
          detail: asks(a) ? 'asks before writes' : 'auto-approves',
          state: asks(a) ? 'on' : 'off'
        }
      ]
    }
  },
  async toggle(ctx, row: { id: string }) {
    if (row.id === 'approval') {
      return flipApproval(ctx)
    }

    if (row.id !== 'thinking') return
    const config = await ctx.engine.getConfig({})

    return update(ctx, { reasoning: thinkingOn(ctx.agent, config) ? 'disabled' : 'enabled' })
  },
  open(ctx, row: { id: string | number }) {
    return AGENT_OPENERS[row.id]?.(ctx)
  }
}

// Latest status per run, as Core's own usage report reads them.
function lastCompleted(chunks: Chunk[]) {
  const latest = new Map<string | null | undefined, Chunk>()
  for (const c of chunks) {
    latest.set(c.runId, c)
  }

  return [...latest.values()]
    .filter((c) => c.runStatus?.state === 'completed' && c.runStatus.metrics)
    .at(-1)?.runStatus?.metrics as UsageMetrics | undefined
}

const PROMPT_ROWS: [string, string][] = [
  ['systemPrompt', 'System prompt'],
  ['agentInstructions', 'Agent instructions'],
  ['activeSkills', 'Skills'],
  ['tools', 'Tools']
]

function promptRows(m: UsageMetrics) {
  const used = m.cacheTokens ?? 0
  const parts =
    m.usage && used
      ? PROMPT_ROWS.map(([key, label]) => ({ key, label, n: m.usage![key] || 0 }))
      : []
  if (!parts.length) {
    return []
  }

  const reported = parts.reduce((s, p) => s + p.n, 0)
  const scale = reported > used ? used / reported : 1
  const rows = parts.map((p) => ({
    id: p.key,
    label: p.label,
    detail: `${tokens(Math.floor(p.n * scale))} tokens`
  }))
  const known = parts.reduce((s, p) => s + Math.floor(p.n * scale), 0)

  return [
    ...rows,
    { id: 'conversation', label: 'Conversation', detail: `${tokens(used - known)} tokens` }
  ]
}

function usageRows(
  m: UsageMetrics,
  compactions: { id: string; label: string; detail: string }
): ScreenRow[] {
  const used = m.cacheTokens ?? 0
  const pct = m.ctxSize && used !== null ? ` (${Math.round((used / m.ctxSize) * 100)}%)` : ''

  return [
    { id: 'window', label: 'Context window', detail: `${tokens(m.ctxSize)} tokens` },
    {
      id: 'used',
      label: 'In use',
      detail: `${tokens(used)} tokens${pct}`,
      badge: pct
        ? { text: pct.trim().slice(1, -1), color: used / (m.ctxSize || 1) > 0.8 ? 'red' : 'teal' }
        : undefined
    },
    ...promptRows(m),
    {
      id: 'speed',
      label: 'Speed',
      detail: m.tokensPerSecond !== null ? `${m.tokensPerSecond.toFixed(1)} tok/s` : '—'
    },
    {
      id: 'ttft',
      label: 'Time to first token',
      detail: m.timeToFirstToken !== null ? `${Math.round(m.timeToFirstToken)} ms` : '—'
    },
    { id: 'stop', label: 'Last stop reason', detail: m.stopReason || '—' },
    compactions
  ]
}

const usage: Screen = {
  title: 'Usage',
  hint: 'c compact now',
  async load(ctx) {
    if (!ctx.chatId) {
      return { rows: [], note: ['Open a chat to see its context usage.'] }
    }

    const scope = { meshId: ctx.meshId, chatId: ctx.chatId }
    const [{ chunks: statuses = [] }, { chunks: folds = [] }] = await Promise.all([
      ctx.engine.listChunks({ ...scope, type: 'run-status' }),
      ctx.engine.listChunks({ ...scope, type: 'compaction' })
    ])
    const m = lastCompleted(statuses ?? [])
    const compactions = {
      id: 'compactions',
      label: 'Compactions',
      detail: String((folds ?? []).length)
    }
    if (!m) {
      return { rows: [compactions], note: ['No completed run in this chat yet.'] }
    }

    return { rows: usageRows(m, compactions) }
  },
  actions: [
    {
      key: 'c',
      label: 'compact now',
      async run(ctx) {
        if (!ctx.chatId) throw new Error('Open a chat to compact it.')
        const r = await ctx.engine.compactChat({ chatId: ctx.chatId, meshId: ctx.meshId })
        return {
          title: 'Compaction',
          lines: r.compacted
            ? [`Folded ${r.foldedTurns ?? 0} turns into a summary.`]
            : [`Nothing was compacted${r.reason ? `: ${r.reason}` : '.'}`]
        }
      }
    }
  ]
}

const knowledge: Screen = {
  title: 'Knowledge',
  hint: 'space toggle  enter remove file',
  async load(ctx) {
    if (!ctx.chatId) {
      return { rows: [], note: ['Open a chat to manage its files.'] }
    }

    const scope = { chatId: ctx.chatId, meshId: ctx.meshId }
    const [chat, { knowledge: files = [] }] = await Promise.all([
      ctx.engine.getChat(scope),
      ctx.engine.listKnowledge(scope)
    ])

    return {
      rows: [
        { id: 'rag', label: 'Use files in answers (RAG)', state: chat?.ragEnabled ? 'on' : 'off' },
        { id: 'web', label: 'Web search', state: chat?.webSearchEnabled ? 'on' : 'off' },
        ...(files ?? []).map((f) => ({
          id: `file:${f.id}`,
          label: f.fileName || f.id,
          detail: [f.mimeType, when(f.createdAt)].filter(Boolean).join(' · '),
          badge: { text: bytes(f.byteLength), color: 'muted' as const }
        }))
      ],
      note: files?.length ? undefined : ['No files in this chat. Attach one to add it.']
    }
  },
  toggle(ctx, row) {
    const input = { chatId: ctx.chatId!, meshId: ctx.meshId, enabled: row.state !== 'on' }
    if (row.id === 'rag') {
      return ctx.engine.setChatRagEnabled(input)
    }

    if (row.id === 'web') {
      return ctx.engine.setChatWebSearchEnabled(input)
    }
    return undefined
  },
  open(ctx, row) {
    if (!row.id.startsWith('file:')) return
    const knowledgeId = row.id.slice(5)
    return {
      prompt: {
        label: `${row.label} · ${row.badge?.text || ''} — type yes to remove`,
        async submit(value: string) {
          if (String(value).trim().toLowerCase() !== 'yes') return
          await ctx.engine.removeKnowledge({ knowledgeId, at: Date.now(), meshId: ctx.meshId })
        }
      }
    }
  }
}

const activity: Screen = {
  title: 'Activity',
  async load(ctx) {
    const { activities = [] } = await ctx.engine.listToolActivity({
      agentId: ctx.agent.id,
      meshId: ctx.meshId,
      limit: 30
    })
    const now = Date.now()

    return {
      rows: (activities ?? []).map((a) => ({
        id: a.id,
        label: a.toolName,
        detail: [
          ago(a.at, now),
          [a.decision, a.effect].filter(Boolean).join('/'),
          a.resource?.label
        ]
          .filter(Boolean)
          .join(' · '),
        badge: a.decision
          ? { text: a.decision, color: /deny|denied|reject/.test(a.decision) ? 'red' : 'muted' }
          : undefined
      })),
      note: activities?.length ? undefined : ['No tool calls yet.']
    }
  }
}

export const screens: Record<string, Screen> = {
  skills,
  tools,
  permissions,
  agent: agentScreen,
  usage,
  knowledge,
  activity
}

const THINKING_LABEL: Record<string, string> = { enabled: 'thinking on', disabled: 'thinking off' }

export function summary(agent: Agent) {
  const skillPart =
    scopeOf(agent) === 'all' ? 'all skills' : `${(agent.enabledSkills || []).length} skills`
  const off = (agent.disabledToolsets || []).length
  const thinking = THINKING_LABEL[agent.reasoning || ''] || 'thinking default'

  return [
    skillPart,
    `${off} toolset${off === 1 ? '' : 's'} off`,
    asks(agent) ? 'asks before writes' : 'auto-approves',
    thinking
  ].join(' · ')
}
