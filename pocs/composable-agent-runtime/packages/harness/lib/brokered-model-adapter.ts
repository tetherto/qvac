import type { ModelAdapter, ModelRequest } from '@qvac/agents'
import type { HarnessAgentRegistration } from './agent-registration.ts'
import { encodeRunScopedIdentity } from './run-identity.ts'
import type { SdkCompletionRun, SdkRuntimePort } from './sdk-runtime-port.ts'
import type { HarnessToolCall, HarnessToolGate } from './tool-broker.ts'
import type { HarnessEvent, HarnessMessage } from './types.ts'

export const MAX_TOOL_ROUNDS = 10
export const TOOL_ROUND_LIMIT_FALLBACK = 'Tool round limit reached before a final response.'

interface CreateBrokeredModelAdapterOptions {
  readonly registration: HarnessAgentRegistration
  readonly sdk: SdkRuntimePort
  readonly tools: HarnessToolGate
  readonly onEvent: (event: HarnessEvent) => Promise<void>
}

interface ActiveOperation {
  readonly request: ModelRequest
  completion?: SdkCompletionRun
}

export function createBrokeredModelAdapter({
  registration,
  sdk,
  tools,
  onEvent
}: CreateBrokeredModelAdapterOptions): ModelAdapter {
  const active = new Map<string, ActiveOperation>()

  return {
    async *stream(request) {
      const operation: ActiveOperation = { request }
      active.set(request.operationId, operation)
      try {
        const loaded = await sdk.loadModel({
          model: request.model,
          traceId: request.operationId,
          signal: request.signal,
          toolSupport: tools.schemas.length > 0
        })
        const messages: HarnessMessage[] = request.messages.map((message) => ({ ...message }))

        for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
          if (request.signal.aborted) return
          const completion = sdk.completion({
            requestId: encodeRunScopedIdentity(
              { agentId: registration.id, runId: request.runId },
              ['completion', request.operationId, round + 1]
            ),
            traceId: request.operationId,
            modelId: loaded.modelId,
            messages,
            signal: request.signal,
            tools: tools.schemas
          })
          operation.completion = completion
          const content: string[] = []
          const calls: Array<HarnessToolCall & { readonly raw?: string }> = []
          let canonicalRaw: string | undefined

          for await (const event of completion.events) {
            if (request.signal.aborted) return
            if (event.type === 'content-delta' || event.type === 'contentDelta') {
              content.push(event.text)
              continue
            }
            if (event.type === 'tool-call' || event.type === 'toolCall') {
              const call = {
                id: event.id ?? `${completion.requestId}/tool/${calls.length + 1}`,
                name: event.name,
                arguments: event.arguments,
                ...(event.raw ? { raw: event.raw } : {})
              }
              calls.push(call)
              await onEvent({ type: 'tool-call', name: call.name, args: call.arguments })
              continue
            }
            if (event.type === 'completion-done' || event.type === 'completionDone') {
              canonicalRaw = event.raw?.fullText
              continue
            }
            if (event.type === 'error') throw new Error(event.message)
            if (event.type === 'cancelled' || event.type === 'aborted') return
          }

          if (request.signal.aborted) return
          if (calls.length === 0) {
            for (const text of content) yield { type: 'content', text }
            return
          }

          messages.push({
            role: 'assistant',
            content: assistantHistory(canonicalRaw, content, calls)
          })
          for (const call of calls) {
            let result
            try {
              result = await tools.execute({
                agentId: registration.id,
                runId: request.runId,
                operationId: request.operationId,
                call,
                signal: request.signal,
                reportProgress: async (progress) => {
                  if (request.signal.aborted) return
                  await onEvent({
                    type: 'tool-progress',
                    name: call.name,
                    progress
                  })
                }
              })
            } catch (error) {
              if (request.signal.aborted) return
              throw error
            }
            if (request.signal.aborted) return
            await onEvent({ type: 'tool-result', name: call.name, result })
            messages.push({ role: 'tool', content: JSON.stringify(result) })
          }
        }

        if (!request.signal.aborted) {
          yield { type: 'content', text: TOOL_ROUND_LIMIT_FALLBACK }
        }
      } finally {
        active.delete(request.operationId)
      }
    },
    async cancel(operationId) {
      const operation = active.get(operationId)
      if (!operation) return
      const cancellations: Promise<void>[] = [
        tools.cancel({
          agentId: registration.id,
          runId: operation.request.runId,
          operationId
        })
      ]
      if (operation.completion) {
        cancellations.push(sdk.cancel({ requestId: operation.completion.requestId }))
      }
      await Promise.all(cancellations)
    }
  }
}

function assistantHistory(
  canonicalRaw: string | undefined,
  content: readonly string[],
  calls: readonly (HarnessToolCall & { readonly raw?: string })[]
) {
  if (canonicalRaw !== undefined) return canonicalRaw
  const text = content.join('')
  if (text) return text
  return JSON.stringify({
    toolCalls: calls.map((call) => ({
      id: call.id,
      name: call.name,
      arguments: call.arguments,
      ...(call.raw ? { raw: call.raw } : {})
    }))
  })
}
