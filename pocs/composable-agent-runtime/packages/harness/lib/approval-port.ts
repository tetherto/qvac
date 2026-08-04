import type { AgentToolInvocation, ToolApprovalPort } from '@qvac/agents'
import type { GeneratedHarnessStream, WireValue } from '../spec/hrpc/index.js'
import { createAsyncQueue } from './queue.ts'

/**
 * An approval the application must decide. Shaped so it can later be committed
 * to durable state without a wire change.
 */
export interface HarnessApprovalRequest {
  readonly approvalId: string
  readonly agentId: string
  readonly runId: string
  readonly operationId: string
  readonly callId: string
  readonly name: string
  readonly args: Readonly<Record<string, unknown>>
}

export interface HarnessApprovalDecision {
  readonly approvalId: string
  readonly approved: boolean
  readonly reason?: string
}

/**
 * `unavailable` means nobody could answer — no listener, a closed stream, or an
 * aborted call. It is not a denial, and must never be treated as one by a
 * caller that would then consult a different authority.
 */
export type HarnessApprovalOutcome = 'approved' | 'denied' | 'unavailable'

interface Deferred {
  resolve(outcome: HarnessApprovalOutcome): void
}

/**
 * Child side. Asks the host to decide, and denies whenever it cannot get an
 * answer: no listener, a closed stream, or an aborted call. Approval must fail
 * closed, since the alternative is running a side-effecting tool unapproved.
 */
export function createRemoteToolApprovalPort() {
  let stream: GeneratedHarnessStream | null = null
  let nextApprovalId = 0
  const pending = new Map<string, Deferred>()

  function attach(next: GeneratedHarnessStream) {
    if (stream) throw new Error('Harness approval port is already attached')
    stream = next
    next.on('data', receive)
    next.on('close', denyAll)
    next.on('error', denyAll)
  }

  function receive(frame: Record<string, WireValue>) {
    if (frame.type !== 'approval-decision') return
    if (typeof frame.approvalId !== 'string') return
    const deferred = pending.get(frame.approvalId)
    if (!deferred) return
    pending.delete(frame.approvalId)
    const data = frame.data as { readonly approved?: unknown } | null | undefined
    deferred.resolve(data?.approved === true ? 'approved' : 'denied')
  }

  function denyAll() {
    stream = null
    // A closed stream is an unanswered request, not a decision.
    for (const deferred of pending.values()) deferred.resolve('unavailable')
    pending.clear()
  }

  /**
   * Tri-state so a caller can tell an explicit denial from an unanswerable
   * request. Collapsing them lets a denial fall through to a second authority.
   */
  function ask(invocation: AgentToolInvocation): Promise<HarnessApprovalOutcome> {
    if (!stream) return Promise.resolve('unavailable')
    if (invocation.signal.aborted) return Promise.resolve('unavailable')
    return askHost(invocation)
  }

  const port: ToolApprovalPort = {
    async approve(invocation: AgentToolInvocation) {
      return (await ask(invocation)) === 'approved'
    }
  }

  function askHost(invocation: AgentToolInvocation): Promise<HarnessApprovalOutcome> {
    {
      const approvalId = `approval-${++nextApprovalId}`
      const request: HarnessApprovalRequest = {
        approvalId,
        agentId: invocation.agentId,
        runId: invocation.runId,
        operationId: invocation.operationId,
        callId: invocation.call.id,
        name: invocation.call.name,
        args: invocation.call.arguments
      }
      return new Promise<HarnessApprovalOutcome>((resolve) => {
        let settled = false
        const settle = (outcome: HarnessApprovalOutcome) => {
          if (settled) return
          settled = true
          pending.delete(approvalId)
          invocation.signal.removeEventListener('abort', onAbort)
          // Tell the host to stop showing a request nobody can answer.
          if (outcome === 'unavailable') withdraw(approvalId)
          resolve(outcome)
        }
        function onAbort() {
          settle('unavailable')
        }
        pending.set(approvalId, { resolve: settle })
        invocation.signal.addEventListener('abort', onAbort, { once: true })
        try {
          stream?.write({
            type: 'approval-request',
            approvalId,
            data: request as unknown as WireValue
          })
        } catch {
          settle('unavailable')
        }
      })
    }
  }

  function withdraw(approvalId: string) {
    try {
      stream?.write({ type: 'approval-withdrawn', approvalId })
    } catch {
      // The stream is gone, so the host has already dropped its request.
    }
  }

  return { port, ask, attach, denyAll }
}

/**
 * Host side. Surfaces child approval requests to the application and writes
 * decisions back. Requests that are never answered stay pending until the
 * stream closes, at which point the child denies them.
 */
export function createHarnessApprovalHost() {
  let stream: GeneratedHarnessStream | null = null
  const queues = new Set<ReturnType<typeof createAsyncQueue<HarnessApprovalRequest>>>()
  const outstanding = new Map<string, HarnessApprovalRequest>()

  function attach(next: GeneratedHarnessStream) {
    stream = next
    next.on('data', (frame: Record<string, WireValue>) => {
      if (typeof frame.approvalId !== 'string') return
      if (frame.type === 'approval-withdrawn') {
        outstanding.delete(frame.approvalId)
        return
      }
      if (frame.type !== 'approval-request') return
      const payload = frame.data as Partial<HarnessApprovalRequest> | null | undefined
      if (!payload) return
      const request: HarnessApprovalRequest = {
        approvalId: frame.approvalId,
        agentId: payload.agentId ?? '',
        runId: payload.runId ?? '',
        operationId: payload.operationId ?? '',
        callId: payload.callId ?? '',
        name: payload.name ?? '',
        args: payload.args ?? {}
      }
      outstanding.set(request.approvalId, request)
      for (const queue of queues) queue.push(request)
    })
    const end = () => {
      stream = null
      outstanding.clear()
      for (const queue of queues) queue.end()
      queues.clear()
    }
    next.on('close', end)
    next.on('error', end)
  }

  function watch(): AsyncIterable<HarnessApprovalRequest> {
    const queue = createAsyncQueue<HarnessApprovalRequest>()
    queues.add(queue)
    for (const request of outstanding.values()) queue.push(request)
    return (async function* () {
      try {
        yield* queue
      } finally {
        queues.delete(queue)
      }
    })()
  }

  async function resolve(decision: HarnessApprovalDecision) {
    if (!stream) throw new Error('Harness approval port is unavailable')
    outstanding.delete(decision.approvalId)
    stream.write({
      type: 'approval-decision',
      approvalId: decision.approvalId,
      data: { approved: decision.approved } as unknown as WireValue,
      ...(decision.reason === undefined ? {} : { reason: decision.reason })
    })
  }

  return { attach, watch, resolve }
}
