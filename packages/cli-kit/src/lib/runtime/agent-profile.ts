import type { Agent, AgentProfile } from '../types.js'
import type { Capabilities } from '@qvac/core/client'
// No node: imports: core-host loads this under Bare.
export const STOCK_BIOS = [
  'You are a helpful local assistant. Be clear, practical, and concise.',
  'You are a helpful local coding assistant. Use tools to verify your work.'
]

const CODING_LEAD =
  'You are QV.AC, a local coding assistant working in the project at the current folder.'

export const CODING_INSTRUCTIONS = [
  CODING_LEAD,
  '',
  'Work like this:',
  '1. Explore before you edit: find files with glob, search with grep, read them with read_file.',
  '   grep is plain text and "a|b" finds either; read from the line numbers it gives.',
  '   Make every read you already know you need in the same turn, several calls at once: they',
  '   run together. Read just the lines you need with startLine and endLine.',
  '2. For a task with more than one step, keep a short plan with update_plan and tick items off.',
  '3. Change files with edit_file. To add text, put a unique neighbouring line in old and repeat',
  '   it in new together with the addition. Never send an empty old.',
  '4. Use write_file only for a new file or a full rewrite.',
  "5. After changing code, run the project's tests or linter with the shell and read the result.",
  '   With no shell tool you cannot run, build or test anything, and no skill or file tool will:',
  '   check the code by reading it against the task, then finish.',
  '6. Independent read-only questions (review these files, search these areas) go to',
  '   subagents with delegate: one self-contained task each, then combine their answers.',
  '7. If the same call fails twice, stop and explain what went wrong instead of retrying.',
  '   Never use sudo. Install dependencies only offline, from the local cache:',
  '   npm install --offline or pnpm install --offline. If that fails, say what is missing.',
  '8. Finish with a short summary of what changed and anything left to do.',
  '',
  'Keep answers short. Quote paths exactly. Ask before anything destructive.'
].join('\n')

// The coding workflow, with where the project is and how its tests run when that is known.
export function codingInstructions({ root, test }: { root: string; test?: string | null }) {
  const where = [`The project is ${root}; use paths relative to it.`]
  if (test) {
    where.push(`Run its tests with: ${test}`)
  }

  return `${CODING_INSTRUCTIONS}\n\n${where.join('\n')}`
}

const FIELDS = [
  'name',
  'reasoning',
  'approvalMode',
  'ctxSize',
  'disabledToolsets',
  'enabledSkills'
] as const

// Any earlier version of the coding instructions starts with the same lead line, so it updates too.
const codingBio = (bio: string | null | undefined) =>
  typeof bio === 'string' && bio.startsWith(CODING_LEAD)

// A bio someone wrote is theirs; only a stock or default one follows the config.
function bioOf(agent: Agent, { instructions }: AgentProfile, explicit: boolean) {
  if (instructions === undefined) {
    return codingBio(agent.bio) ? STOCK_BIOS[0] : undefined
  }

  const ours = explicit || STOCK_BIOS.includes(agent.bio ?? '') || codingBio(agent.bio)

  return ours ? instructions : undefined
}

// A default only adds to what the user hid in /tools; a list in qvac.config is the whole list.
function toolsets(agent: Agent, profile: AgentProfile, sources: Record<string, string>) {
  const listed = profile.disabledToolsets
  if (listed === undefined || sources['core.agent.disabledToolsets'] === 'config') {
    return listed
  }

  const current = agent.disabledToolsets || []

  return [...current, ...(listed ?? []).filter((name) => !current.includes(name))]
}

// Applies core.agent to a hosted agent and returns the fields it changed, {} when none.
export async function applyAgentProfile(
  engine: Capabilities,
  {
    meshId,
    agent,
    profile = {},
    sources = {}
  }: { meshId: string; agent: Agent; profile?: AgentProfile; sources?: Record<string, string> }
) {
  const changed: Parameters<Capabilities['updateAgent']>[0]['config'] = {}
  const bio = bioOf(agent, profile, sources['core.agent.instructions'] === 'config')
  if (bio !== undefined && bio !== agent.bio) {
    changed.bio = bio
  }

  const wanted = { ...profile, disabledToolsets: toolsets(agent, profile, sources) }
  for (const key of FIELDS) {
    // a list read back from Core is a new array, so equal means equal as JSON
    if (wanted[key] !== undefined && JSON.stringify(wanted[key]) !== JSON.stringify(agent[key])) {
      Object.assign(changed, { [key]: wanted[key] })
    }
  }

  if (Object.keys(changed).length) {
    await engine.updateAgent({ agentId: agent.id, meshId, config: changed })
  }

  return changed
}

// Each tool's settings from qvac.config, written only where Core holds something else.
export async function applyToolConfigs(
  engine: Capabilities,
  {
    meshId,
    agent,
    configs
  }: { meshId: string; agent: Agent; configs: Record<string, Record<string, unknown>> }
) {
  const { configs: stored } = await engine.listToolConfigs({ agentId: agent.id, meshId })
  const current = new Map(
    (stored ?? [])
      .filter((config) => !config.deletedAt)
      .map((config) => [config.toolName, JSON.stringify(config.settings)])
  )
  const changed = Object.keys(configs).filter(
    (toolName) => current.get(toolName) !== JSON.stringify(configs[toolName])
  )
  for (const toolName of changed) {
    await engine.setToolConfigs({
      agentId: agent.id,
      meshId,
      toolName,
      settings: configs[toolName]
    })
  }

  return changed
}
