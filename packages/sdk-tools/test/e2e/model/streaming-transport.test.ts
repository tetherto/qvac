import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { useSpawnedServer } from '../helpers/cli.js'
import { LLM_ONLY_CONFIG, E2E } from '../helpers/config.js'

// Real-socket fidelity for streaming — the part app.inject can't reach: SSE
// chunks delivered over the wire and a client hang-up mid-stream exercising
// the cancel-bridge. Spawned binary with a single small LLM.
describe('http streaming over a real socket', () => {
  const baseUrl = useSpawnedServer(LLM_ONLY_CONFIG)

  function streamChat(signal?: AbortSignal): Promise<Response> {
    return fetch(`${baseUrl()}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: E2E.llm,
        messages: [{ role: 'user', content: 'Say hi.' }],
        stream: true,
        max_tokens: 512
      }),
      ...(signal !== undefined ? { signal } : {})
    })
  }

  it('delivers SSE chunks over the socket and terminates with [DONE]', async () => {
    const res = await streamChat()
    assert.equal(res.status, 200)
    assert.match(String(res.headers.get('content-type')), /text\/event-stream/)
    assert.ok(res.body !== null)

    const reader = res.body.getReader()
    const decoder = new TextDecoder()
    let buf = ''
    const dataFrames: string[] = []
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      buf += decoder.decode(value, { stream: true })
      const parts = buf.split('\n\n')
      buf = parts.pop() ?? ''
      for (const p of parts) {
        const line = p.split('\n').find((l) => l.startsWith('data:'))
        if (line !== undefined) dataFrames.push(line.slice('data:'.length).trim())
      }
    }

    assert.ok(dataFrames.includes('[DONE]'), 'expected [DONE] sentinel over the socket')
    assert.ok(
      dataFrames.filter((d) => d !== '[DONE]').length > 1,
      'expected multiple SSE data frames'
    )
  })

  it('survives a client hang-up mid-stream (cancel-bridge)', async () => {
    const controller = new AbortController()
    const res = await streamChat(controller.signal)
    assert.ok(res.body !== null)
    const reader = res.body.getReader()
    await reader.read() // take one chunk, then hang up
    controller.abort()
    try {
      await reader.read()
    } catch {
      /* aborted — expected */
    }

    // The server must stay healthy after a client disconnects mid-generation.
    const ping = await fetch(`${baseUrl()}/v1/models`)
    assert.equal(ping.status, 200)
  })
})
