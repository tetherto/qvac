const assert = require('node:assert/strict')
const http = require('node:http')
const path = require('node:path')
const { spawn } = require('node:child_process')
const { once } = require('node:events')
const { setTimeout: delay } = require('node:timers/promises')
const test = require('node:test')

// Contract fixtures follow QVAC Grid de1d78416's
// src/entrypoints/http_server.cpp (write_sse_header/write_sse/finish_sse)
// src/entrypoints/openai/serving_chat.cpp (chat_sse_chunk_json), and
// src/entrypoints/openai/protocol.cpp (openai_error_json/streaming_error_json).
// The HTTP server is mocked; the public addon, native binding and sockets are real.
function chunk(delta, finish = null) {
  return {
    id: 'chatcmpl-test',
    object: 'chat.completion.chunk',
    created: 1,
    model: 'test-model',
    choices: [
      {
        index: 0,
        delta: { reasoning_content: null, ...delta },
        logprobs: null,
        finish_reason: finish,
        matched_stop: null
      }
    ]
  }
}

const sse = (value) => `data: ${JSON.stringify(value)}\n\n`
const expectedTokens = ['Hello ', '🌍\n"\\']

async function exercise(t, scenario) {
  const requests = []
  let responseEnded = false
  let streamedBeforeEnd = false
  let cancelledConnection = false
  const server = http.createServer(async (req, res) => {
    try {
      let raw = ''
      for await (const part of req) raw += part
      requests.push({
        method: req.method,
        path: req.url,
        headers: req.headers,
        body: JSON.parse(raw)
      })
      const attempt = requests.length
      if (
        scenario === 'http-error' ||
        (scenario === 'authenticated' &&
          req.headers.authorization !== 'Bearer integration-test-key')
      ) {
        const body = JSON.stringify({
          object: 'error',
          message:
            scenario === 'http-error' ? 'max_tokens exceeds the context limit' : 'Invalid API key',
          type: 'BadRequestError',
          param: null,
          code: scenario === 'http-error' ? 400 : 401
        })
        res.writeHead(scenario === 'http-error' ? 400 : 401, {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body),
          Connection: 'close'
        })
        res.end(body)
        return
      }
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'close',
        'Transfer-Encoding': 'chunked',
        'X-Accel-Buffering': 'no'
      })
      res.flushHeaders()
      res.write(sse(chunk({ role: 'assistant', content: '' })))
      res.write(sse(chunk({ reasoning_content: 'private reasoning' })))
      res.write(sse(chunk({ content: expectedTokens[0] })))
      if (scenario === 'cancel' && attempt === 1) {
        res.on('close', () => {
          cancelledConnection = true
        })
        return // Cancellation must interrupt the native socket read.
      }
      if (scenario === 'truncated') {
        await delay(30)
        res.destroy() // No terminating HTTP chunk or SSE [DONE].
        return
      }
      if (scenario === 'stream-error') {
        res.end(
          sse({
            error: {
              object: 'error',
              message: 'generation failed',
              type: 'Internal Server Error',
              param: null,
              code: 500
            }
          }) + 'data: [DONE]\n\n'
        )
        return
      }
      // Split an SSE record and a multibyte UTF-8 code point across HTTP chunks.
      const bytes = Buffer.from(sse(chunk({ content: expectedTokens[1] })))
      const split = bytes.indexOf(Buffer.from('🌍')) + 1
      res.write(bytes.subarray(0, split))
      await delay(20)
      res.write(bytes.subarray(split))
      if (scenario === 'missing-done') {
        res.end() // A clean HTTP ending does not complete the SSE protocol.
        return
      }
      res.write(sse(chunk({}, 'stop')))
      res.write(
        sse({
          id: 'chatcmpl-test',
          object: 'chat.completion.chunk',
          created: 1,
          model: 'test-model',
          choices: [],
          usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 }
        })
      )
      // Hold completion until the parent observes a token, proving incremental delivery.
      if (scenario === 'success') {
        for (let i = 0; i < 100 && !streamedBeforeEnd; i++) await delay(10)
      }
      responseEnded = true
      res.end('data: [DONE]\n\n')
    } catch (error) {
      res.destroy(error)
    }
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const child = spawn(
    process.env.BARE_BIN || 'bare',
    [path.join(__dirname, 'client.cjs'), scenario, `http://127.0.0.1:${server.address().port}`],
    {
      stdio: ['ignore', 'pipe', 'pipe']
    }
  )
  t.after(() => {
    child.kill('SIGKILL')
    server.closeAllConnections()
    server.close()
  })
  const timer = setTimeout(() => child.kill('SIGKILL'), 10_000)
  t.after(() => clearTimeout(timer))
  let stdout = ''
  let stderr = ''
  child.stdout.on('data', (data) => {
    stdout += data
    if (stdout.includes('TOKEN ') && !responseEnded) streamedBeforeEnd = true
  })
  child.stderr.on('data', (data) => {
    stderr += data
  })
  const [code, signal] = await once(child, 'close')
  assert.equal(code, 0, `Bare failed (${signal || code}): ${stderr}\n${stdout}`)
  const resultLine = stdout.split('\n').find((line) => line.startsWith('RESULT '))
  assert.ok(resultLine, `Missing Bare result: ${stderr}\n${stdout}`)
  for (const request of requests) {
    assert.equal(request.method, 'POST')
    assert.equal(request.path, '/v1/chat/completions')
    assert.equal(request.headers['content-type'], 'application/json')
    assert.deepEqual(request.body, {
      messages: [
        { role: 'system', content: 'Be concise.' },
        { role: 'user', content: 'Hello 🌍\n"quoted" \\ text' }
      ],
      stream: true,
      temperature: 0,
      top_p: 0.9,
      top_k: 20,
      max_tokens: 8,
      seed: 0,
      repetition_penalty: 1.1
    })
  }
  return {
    results: JSON.parse(resultLine.slice(7)),
    requests,
    streamedBeforeEnd,
    cancelledConnection
  }
}

test('native addon posts the real chat API shape and incrementally reads fragmented SSE', async (t) => {
  const { results, requests, streamedBeforeEnd } = await exercise(t, 'success')
  assert.equal(requests.length, 1)
  assert.deepEqual(results, [
    { tokens: expectedTokens, result: expectedTokens, iterated: expectedTokens }
  ])
  assert.equal(streamedBeforeEnd, true)
})

test('native addon surfaces HTTP validation errors', async (t) => {
  const { results } = await exercise(t, 'http-error')
  assert.match(results[0].error, /max_tokens exceeds the context limit/)
})

test('native addon surfaces errors after streaming starts', async (t) => {
  const { results } = await exercise(t, 'stream-error')
  assert.match(results[0].error, /generation failed/)
})

test('native addon rejects a truncated HTTP stream', async (t) => {
  const { results } = await exercise(t, 'truncated')
  assert.match(results[0].error, /truncated chunked HTTP body/)
})

test('native addon rejects an SSE response without its completion marker', async (t) => {
  const { results } = await exercise(t, 'missing-done')
  assert.match(results[0].error, /SSE.*DONE|incomplete.*stream/i)
})

test('cancelling interrupts the socket and permits the next request', async (t) => {
  const { results, requests, cancelledConnection } = await exercise(t, 'cancel')
  assert.equal(requests.length, 2)
  assert.equal(cancelledConnection, true)
  assert.deepEqual(results[0].tokens, [expectedTokens[0]])
  assert.equal(results[0].error, undefined)
  assert.deepEqual(results[1].tokens, expectedTokens)
  assert.equal(results[1].error, undefined)
})

test('the addon can complete two consecutive requests and unload', async (t) => {
  const { results, requests } = await exercise(t, 'sequential')
  assert.equal(requests.length, 2)
  assert.deepEqual(
    results.map((result) => result.tokens),
    [expectedTokens, expectedTokens]
  )
  assert.ok(results.every((result) => !result.error))
})

test('configured API keys authenticate the native HTTP request', async (t) => {
  const { results } = await exercise(t, 'authenticated')
  assert.equal(results[0].error, undefined)
  assert.deepEqual(results[0].tokens, expectedTokens)
})
