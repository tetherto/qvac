import { describe, expect, it } from 'vitest'
import { duplexPair } from '@qvac/harness'
import {
  createPublicSdkBridge,
  mapPublicSdkCompletionEvent
} from '../lib/react-native-adapters.ts'

describe('react-native public SDK bridge', () => {
  it('maps supported and unsupported SDK events explicitly', () => {
    expect(
      mapPublicSdkCompletionEvent({ type: 'contentDelta', text: 'hello' })
    ).toEqual({ type: 'contentDelta', text: 'hello' })
    expect(
      mapPublicSdkCompletionEvent({ type: 'thinkingDelta', text: 'plan' })
    ).toEqual({ type: 'thinkingDelta', text: 'plan' })
    expect(
      mapPublicSdkCompletionEvent({
        type: 'completionDone',
        stopReason: 'unsupported-stop'
      })
    ).toEqual({
      type: 'completionDone',
      stopReason: 'error',
      error: { message: 'unmapped SDK stop reason: unsupported-stop' }
    })
    expect(
      mapPublicSdkCompletionEvent({ type: 'totallyNewEvent' })
    ).toEqual({
      type: 'completionDone',
      stopReason: 'error',
      error: { message: 'unmapped SDK event: totallyNewEvent' }
    })
    expect(
      mapPublicSdkCompletionEvent({ type: 'completionDone', stopReason: 'length' })
    ).toEqual({ type: 'completionDone', stopReason: 'eos' })
    expect(
      mapPublicSdkCompletionEvent({
        type: 'completionDone',
        stopReason: 'stopSequence'
      })
    ).toEqual({ type: 'completionDone', stopReason: 'eos' })
    expect(
      mapPublicSdkCompletionEvent({ type: 'completionDone' })
    ).toEqual({ type: 'completionDone', stopReason: 'eos' })
  })

  it('bridges load, stream, cancel, heartbeat, and close', async () => {
    const [hostStream, workerStream] = duplexPair()
    const calls: string[] = []
    const bridge = await createPublicSdkBridge({
      sdkIpc: hostStream,
      publicSdk: {
        async loadModel({ modelSrc }) {
          calls.push(`load:${modelSrc}`)
          return `loaded:${modelSrc}`
        },
        completion() {
          calls.push('completion')
          return {
            requestId: 'host-run-1',
            events: (async function* () {
              yield { type: 'contentDelta', text: 'a' }
              yield { type: 'completionDone', stopReason: 'eos' }
            })()
          }
        },
        async cancel({ requestId }) {
          calls.push(`cancel:${requestId}`)
        },
        async heartbeat() {
          calls.push('heartbeat')
          return { ok: true }
        },
        async close() {
          calls.push('sdk-close')
        }
      }
    })

    const { createWorkerSdkRuntimePort } = await import('@qvac/harness')
    const worker = createWorkerSdkRuntimePort(workerStream)
    const loaded = await worker.loadModel({
      model: 'registry://model.gguf',
      traceId: 'trace-bridge-load'
    })
    expect(loaded.modelId).toBe('loaded:registry://model.gguf')

    const abort = new AbortController()
    const run = worker.completion({
      requestId: 'local-run-1',
      traceId: 'trace-bridge-run',
      modelId: loaded.modelId,
      messages: [{ role: 'user', content: 'hi' }],
      signal: abort.signal
    })
    const events = []
    for await (const event of run.events) {
      events.push(event.type)
      if (event.type === 'content-delta') {
        abort.abort('stop')
        await worker.cancel({ requestId: 'local-run-1' })
      }
    }
    expect(events).toEqual(['content-delta'])

    await expect(worker.heartbeat()).resolves.toEqual({ ok: true })
    await worker.close()
    await bridge.close()
    expect(calls).toEqual([
      'load:registry://model.gguf',
      'completion',
      'cancel:host-run-1',
      'heartbeat',
      'sdk-close'
    ])
  })
})
