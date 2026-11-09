import type { Capabilities } from '@qvac/core/client'
type WatchValue<T> = T extends AsyncIterable<infer V> ? V : never
export type Chunk = NonNullable<
  WatchValue<ReturnType<Capabilities['chunksWatch']>>['chunks']
>[number]
export interface RunStatus {
  state?: string | undefined
  reason?: string | null | undefined
  stopReason?: string | undefined
  error?: { message?: string } | undefined
  metrics?: RunMetrics | null | undefined
  progress?: { phase: string; model?: string | null; percentage?: number } | null | undefined
}
export interface RunMetrics {
  ctxSize?: number
  stopReason?: string
  inputTokens?: number
  outputTokens?: number
  totalTokens?: number
  tokensPerSecond?: number
  durationMs?: number
  contextWindow?: number
  contextTokens?: number
  context?: { used?: number; window?: number; cached?: number }
  [key: string]: unknown
}
export interface SegmentDetail {
  agentId?: string | null | undefined
  text?: string | undefined
  name?: string | undefined
  arguments?: Record<string, unknown> | null | undefined
  result?: unknown
  status?: string | undefined
  fileName?: string | undefined
  resource?: { kind: string; label: string } | null | undefined
  display?: { label?: string } | null | undefined
  sources?: { title?: string; url?: string | null }[] | undefined
}
export interface Segment {
  type: string
  text?: string | undefined
  detail: SegmentDetail
  id?: string | undefined
  intent?: string | null | undefined
}
export interface AgentTurn {
  from: 'agent'
  runId: string | null | undefined
  status: string | null | undefined
  segments: Segment[]
  run?: RunStatus | undefined
}
export interface UserTurn {
  from: 'user'
  text: string
}
export interface FileTurn {
  from: 'file'
  file: Partial<NonNullable<Chunk['attachment']>>
}
export interface CompactionTurn {
  from: 'compaction'
}
export type Turn = AgentTurn | UserTurn | FileTurn | CompactionTurn

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' ? (value as Record<string, unknown>) : {}
}
function detailOf(value: unknown): SegmentDetail {
  const valueRecord = record(value)
  return valueRecord as SegmentDetail
}
const SETTLED = new Set(['completed', 'failed', 'canceled', 'cancelled'])
const PAYLOAD: Record<string, keyof Chunk> = {
  content: 'content',
  thinking: 'thinking',
  'tool-call': 'toolCall',
  'tool-result': 'toolResult',
  attachment: 'attachment'
}

export const settled = (turn: Pick<AgentTurn, 'status'>) => SETTLED.has(turn.status ?? '')

export function turns(chunks: readonly Chunk[]): Turn[] {
  const out: Turn[] = [],
    byRun = new Map<string | null | undefined, AgentTurn>()
  for (const chunk of [...chunks].sort((a, b) => a.seq - b.seq)) {
    if (chunk.type === 'user-message') {
      out.push({ from: 'user', text: chunk.userMessage?.text || '' })
      continue
    }

    if (chunk.type === 'attachment' && !chunk.runId) {
      out.push({ from: 'file', file: chunk.attachment || {} })
      continue
    }

    if (chunk.type === 'compaction') {
      out.push({ from: 'compaction' })
      continue
    }

    let turn = byRun.get(chunk.runId)
    if (!turn) {
      turn = { from: 'agent', runId: chunk.runId, status: null, segments: [] }
      byRun.set(chunk.runId, turn)
      out.push(turn)
    }

    apply(turn, chunk)
  }

  return out
}

function apply(turn: AgentTurn, chunk: Chunk) {
  if (chunk.type === 'run-request') {
    return
  }

  if (chunk.type === 'run-status') {
    turn.status = chunk.runStatus?.state
    turn.run = (chunk.runStatus || {}) as RunStatus
    return
  }

  if (chunk.type === 'approval-request') {
    turn.segments.push({
      type: 'approval',
      id: chunk.id,
      intent: chunk.intent,
      detail: detailOf({ ...chunk.approvalRequest, display: chunk.display })
    })
    return
  }

  if (chunk.type === 'sources') {
    turn.segments = turn.segments.filter((s: { type: string }) => s.type !== 'sources')
    turn.segments.push({ type: 'sources', detail: chunk.sources || {} })
    return
  }

  const field = PAYLOAD[chunk.type]
  const detail = detailOf(field ? chunk[field] : undefined),
    last = turn.segments.at(-1)
  if (last?.type === chunk.type && ['content', 'thinking'].includes(last.type)) {
    last.text = (last.text || '') + (detail.text || '')
  } else {
    turn.segments.push({ type: chunk.type, text: detail.text || '', detail })
  }
}

export function pendingApproval(list: readonly Turn[]) {
  for (let i = list.length - 1; i >= 0; i--) {
    const turn = list[i]!
    if (turn.from !== 'agent' || settled(turn)) {
      continue
    }

    const segment = [...turn.segments]
      .reverse()
      .find((s) => s.type === 'approval' && s.detail.status === 'pending')
    if (segment) {
      return segment
    }
  }

  return null
}

// The run in progress: a message sent while it goes waits as a later unsettled turn behind it.
export function activeRun(list: readonly Turn[]) {
  const agents = list.filter((t): t is AgentTurn => t.from === 'agent')
  let at = agents.length
  while (at > 0 && !settled(agents[at - 1]!)) {
    at--
  }

  return agents[at] ?? null
}
