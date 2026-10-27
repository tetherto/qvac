interface ManagedWatch {
  on(event: string, listener: (...args: never[]) => void): unknown
  once(event: string, listener: (...args: never[]) => void): unknown
  removeListener(event: string, listener: (...args: never[]) => void): unknown
  destroy(): void
}
import type { Capabilities } from '@qvac/core/client'
type Chunk = NonNullable<Awaited<ReturnType<Capabilities['listChunks']>>['chunks']>[number]
interface Message {
  kind: string
  text: string
  detail?: string
  runId?: string | null | undefined
  content?: boolean
}
interface PendingApproval {
  kind: string
  id: string
  runId?: string | null | undefined
  name: string
  arguments: string
  intent?: string | null | undefined
  agentId?: string | null | undefined
}
export interface Transcript {
  messages: Message[]
  runId: string | null
  pending: PendingApproval | null
}
type Scope = { meshId: string; chatId: string }
export type ChatEvent =
  | { type: 'connection'; connected: false; error: Error }
  | ({ type: 'transcript'; truncated: boolean } & Transcript)
const settled = new Set(['completed', 'failed', 'canceled'])
const describe = (value: unknown) =>
  typeof value === 'string' ? value : JSON.stringify(value ?? {})

const MESSAGES = new Map<string, (chunk: Chunk, runId?: string | null) => Message | undefined>([
  ['user-message', (chunk) => ({ kind: 'user', text: chunk.userMessage?.text || '' })],
  ['content', (chunk, runId) => ({ kind: 'assistant', text: chunk.content?.text || '', runId })],
  [
    'thinking',
    (chunk, runId) => ({
      kind: 'tool',
      text: 'Thinking',
      detail: chunk.thinking?.text || '',
      runId
    })
  ],
  [
    'tool-call',
    (chunk, runId) => ({
      kind: 'tool',
      text: `Call · ${chunk.toolCall?.name || 'tool'}`,
      detail: describe(chunk.toolCall?.arguments),
      runId
    })
  ],
  [
    'tool-result',
    (chunk, runId) => ({
      kind: 'tool',
      text: `Result · ${chunk.toolResult?.name || 'tool'}`,
      detail: describe(chunk.toolResult?.result),
      runId
    })
  ],
  [
    'attachment',
    (chunk, runId) => ({
      kind: 'tool',
      text: `Attachment · ${chunk.attachment?.fileName || 'file'}`,
      detail: chunk.attachment?.mimeType || '',
      runId
    })
  ],
  [
    'compaction',
    (chunk) => ({ kind: 'tool', text: 'Context compacted', detail: describe(chunk.compaction) })
  ],
  [
    'sources',
    (chunk, runId) => ({ kind: 'tool', text: 'Sources', detail: describe(chunk.sources), runId })
  ],
  [
    'run-status',
    (chunk, runId) =>
      chunk.runStatus?.state === 'failed'
        ? {
            kind: 'assistant',
            text: `Run failed: ${chunk.runStatus.reason || 'No reason reported'}`,
            runId
          }
        : undefined
  ]
])

export function transcript(chunks: Chunk[]): Transcript {
  const messages: Message[] = [],
    runs = new Map<string | null | undefined, string | null | undefined>(),
    approvals: PendingApproval[] = []
  for (const chunk of [...chunks].sort((a, b) => a.seq - b.seq)) {
    const runId = chunk.runId
    if (runId && !runs.has(runId)) {
      runs.set(runId, null)
    }

    if (chunk.type === 'run-status') {
      runs.set(runId, chunk.runStatus?.state)
    }

    const message = MESSAGES.get(chunk.type)?.(chunk, runId)
    if (message) {
      appendMessage(messages, message, chunk)
    }

    if (chunk.type === 'approval-request' && chunk.approvalRequest?.status === 'pending') {
      approvals.push({
        kind: 'approval',
        id: chunk.id,
        runId,
        name: chunk.approvalRequest.name,
        arguments: describe(chunk.approvalRequest.arguments),
        intent: chunk.intent,
        agentId: chunk.approvalRequest.agentId
      })
    }
  }

  const active = [...runs].filter(([id, status]) => id && !settled.has(status ?? ''))

  return {
    messages,
    runId: active.at(-1)?.[0] || null,
    pending: approvals.find((a) => !settled.has(runs.get(a.runId) ?? '')) || null
  }
}

// streamed content of one run arrives in pieces, so consecutive pieces join one message
function appendMessage(messages: Message[], message: Message, chunk: Chunk) {
  const last = messages.at(-1)
  if (
    message.kind === 'assistant' &&
    chunk.type === 'content' &&
    last?.kind === 'assistant' &&
    last.runId === chunk.runId &&
    last.content === true
  ) {
    last.text += message.text
  } else {
    messages.push({ ...message, content: chunk.type === 'content' })
  }
}

// The owning host supplies the Client; a watch failure disables mutations until a fresh attach.
export class ChatSession {
  client: Capabilities
  generation: number
  dispose: (() => void) | null
  scope: Scope | null
  ready: boolean
  snapshot: Transcript | null

  constructor(client: Capabilities) {
    this.client = client
    this.generation = 0
    this.dispose = null
    this.scope = null
    this.ready = false
    this.snapshot = null
  }

  attach({ meshId, chatId }: Scope, emit: (event: ChatEvent) => void) {
    if (!meshId || !chatId) throw new Error('A chat and its mesh are required.')
    this.close()
    const generation = this.generation
    this.scope = { meshId, chatId }
    try {
      const stream = this.client.chunksWatch({
        ...this.scope,
        reverse: true,
        limit: 500
      }) as ReturnType<Capabilities['chunksWatch']> & ManagedWatch
      const failed = (error: Error) => {
        if (generation === this.generation) {
          this.ready = false
          emit({ type: 'connection', connected: false, error })
        }
      }
      const data = (frame: Awaited<ReturnType<Capabilities['listChunks']>>) => {
        if (generation !== this.generation) return
        if (!Array.isArray(frame?.chunks)) {
          failed(new Error('Invalid transcript frame'))
          return
        }

        this.snapshot = transcript(frame.chunks)
        this.ready = true
        emit({ type: 'transcript', ...this.snapshot, truncated: frame.chunks.length >= 500 })
      }
      const ended = () => failed(new Error('Chat connection ended. Reconnect before sending.'))
      stream.on('data', data)
      stream.on('error', failed)
      stream.on('end', ended)
      stream.on('close', ended)
      this.dispose = () => {
        stream.removeListener('data', data)
        stream.removeListener('end', ended)
        stream.removeListener('close', ended)
        stream.once('close', () => stream.removeListener('error', failed))
        stream.destroy()
      }
    } catch (error) {
      this.close()
      throw error
    }
  }

  requireReady() {
    if (!this.ready || !this.scope) {
      throw new Error('Chat is disconnected. Reconnect before continuing.')
    }

    return { ...this.scope }
  }

  send(text: string) {
    const scope = this.requireReady()
    if (!text?.trim()) {
      throw new Error('A message cannot be empty.')
    }

    return this.client.sendMessage({ ...scope, text })
  }

  stop() {
    const scope = this.requireReady(),
      runId = this.snapshot?.runId
    if (!runId) {
      return Promise.resolve()
    }

    return this.client.stopRun({ ...scope, runId })
  }

  approve(id: string, approved: boolean) {
    const scope = this.requireReady(),
      pending = this.snapshot?.pending
    if (!pending || id !== pending.id) {
      throw new Error('This approval is no longer pending.')
    }

    return this.client.resolveApproval({
      meshId: scope.meshId,
      chunkId: id,
      approved: approved === true,
      scope: 'once',
      agentId: pending.agentId ?? null
    })
  }

  close() {
    this.generation++
    this.ready = false
    this.scope = null
    this.snapshot = null
    const dispose = this.dispose
    this.dispose = null
    dispose?.()
  }
}
