import type { Harness, CompletionContext, AccessPolicy } from '@qvac/harness'
import type { Agent as AgentClass } from '@qvac/harness/agent'
import type {
  ExternalAgents as ExternalAgentsClass,
  AgentTargetConfig
} from '@qvac/harness/plugins/external-agents'
type Target = AgentTargetConfig & { userLoginApproved?: boolean }
type DelegateTarget = ReturnType<typeof ExternalAgentsClass.targets>[number]
interface DelegateEvent {
  type: 'delegate-event'
  target: string
  parentRunId?: string | undefined
  runId?: string | undefined
  event: unknown
}
interface CodingOptions {
  harness: Pick<Harness, 'completion'>
  Agent: typeof AgentClass
  ExternalAgents: typeof ExternalAgentsClass
  model: string
  projectDir: string
  dataDir: string
  targets?: Target[]
  network?: 'on' | 'off'
  planMode?: boolean
  approve?: CompletionContext['approve']
  signal?: CompletionContext['signal']
  onEvent?: (event: DelegateEvent) => void
  task: string
  slots?: number
  maxExternal?: number
}
const EXPLORER = {
  id: 'explorer',
  bio: 'Answer the assigned code question with file evidence. Do not change files.'
}

const LEAD = {
  id: 'lead',
  plan: true,
  bio: 'Keep a plan. Explore locally. Delegate narrow tasks only to listed targets when useful. Validate returned work and report the evidence.',
  handoffs: [{ id: 'reviewer', description: 'Review the completed change and its validation' }]
}

const REVIEWER = {
  id: 'reviewer',
  bio: 'Review the change and its test evidence. Report concrete defects. Return work to the lead when corrections are needed.',
  handoffs: [{ id: 'lead', description: 'Address review findings' }]
}

export function codingRun({
  harness,
  Agent,
  ExternalAgents,
  model,
  projectDir,
  dataDir,
  targets = [],
  network = 'off',
  planMode = false,
  approve,
  signal,
  onEvent,
  task,
  slots = 1,
  maxExternal = 2
}: CodingOptions) {
  assertRun({ model, projectDir, dataDir, task, slots, maxExternal, network, targets })

  const configured =
    network === 'on' && !planMode
      ? targets.map(({ userLoginApproved, ...config }) => ({
          ...config,
          login: config.login || ('isolated' as const)
        }))
      : []
  const external = configured.length
    ? ExternalAgents.targets({ dir: dataDir, targets: configured })
    : []
  const policy: AccessPolicy = { network: { mode: network } }
  const base: CompletionContext = {
    model,
    agent: EXPLORER,
    messages: [],
    grantedDirs: [projectDir],
    grantedWriteDirs: [],
    policy,
    ...(signal ? { signal } : {})
  }
  const delegate = Agent.delegateTool(harness, base, {
    slots,
    maxExternal,
    targets: external.map((target) => observed(target, onEvent)),
    read: []
  })

  return harness.completion({
    model,
    agent: LEAD,
    agents: { lead: LEAD, reviewer: REVIEWER },
    messages: [{ role: 'user', content: task }],
    tools: [delegate],
    grantedDirs: [projectDir],
    grantedWriteDirs: planMode ? [] : [projectDir],
    policy,
    planMode,
    ...(signal ? { signal } : {}),
    approve: approve || (async () => false),
    maxToolRounds: 40
  })
}

function assertRun({
  model,
  projectDir,
  dataDir,
  task,
  slots,
  maxExternal,
  network,
  targets
}: Required<
  Pick<
    CodingOptions,
    'model' | 'projectDir' | 'dataDir' | 'task' | 'slots' | 'maxExternal' | 'network' | 'targets'
  >
>) {
  if (!projectDir || !dataDir || !model || !task?.trim()) {
    throw new Error('model, projectDir, dataDir and task are required')
  }

  if (!Number.isInteger(slots) || slots < 1 || !Number.isInteger(maxExternal) || maxExternal < 1) {
    throw new Error('Concurrency must be positive integers')
  }

  if (!['on', 'off'].includes(network)) {
    throw new Error('network must be on or off')
  }

  const names = new Set()
  for (const target of targets) {
    if (!target.name || target.name === 'local' || names.has(target.name)) {
      throw new Error('External target names must be unique and cannot be local')
    }

    names.add(target.name)
    if (!['claude', 'codex', 'acp'].includes(target.protocol) || !target.command) {
      throw new Error('An external target needs a supported protocol and an installed command')
    }

    if (target.login === 'user' && target.userLoginApproved !== true) {
      throw new Error(`Opt in to the user login for ${target.name}`)
    }
  }
}

function observed(target: DelegateTarget, onEvent: CodingOptions['onEvent']): DelegateTarget {
  return {
    ...target,
    run(request, taskSignal) {
      return target.run(
        {
          ...request,
          onEvent(event) {
            request.onEvent?.(event)
            onEvent?.({
              type: 'delegate-event',
              target: target.name,
              parentRunId: request.parentRunId,
              runId: request.runId,
              event
            })
          }
        },
        taskSignal
      )
    }
  }
}
