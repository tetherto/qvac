import assert from 'node:assert/strict'
import { spawn, type ChildProcess } from 'node:child_process'
import { once } from 'node:events'
import { resolve } from 'node:path'
import type { Readable } from 'node:stream'
import { test } from 'node:test'

interface ListeningLine {
  readonly proxyToken: string
  readonly baseURL: string
  readonly modelId: string
  readonly modelName: string
}

interface ReadyLine {
  readonly baseURL: string
  readonly servePort: number
  readonly pid: number
  readonly modelId: string
}

const integration = process.env['QVAC_INTEGRATION_TEST'] === '1'
const timeoutMs = Number(process.env['QVAC_INTEGRATION_TIMEOUT_MS'] ?? 1_200_000)
// The handshake must land as soon as the proxy listens, so a cold model
// download stays first-request work instead of plugin-startup work.
const handshakeBudgetMs = 10_000

function parseJsonPayload<T>(line: string, marker: string): T {
  const raw = line.slice(marker.length).trim()
  return JSON.parse(raw) as T
}

function waitForJsonLine<T>(
  child: ChildProcess,
  stream: Readable,
  marker: string,
  timeout: number
): Promise<T> {
  return new Promise((resolveLine, reject) => {
    let buffer = ''
    const timer = setTimeout(() => {
      cleanup()
      reject(new Error(`timed out waiting for ${marker}`))
    }, timeout)

    function cleanup(): void {
      clearTimeout(timer)
      stream.off('data', onData)
      child.off('exit', onExit)
    }

    function onExit(code: number | null, signal: NodeJS.Signals | null): void {
      cleanup()
      reject(
        new Error(`host exited before ${marker}: code=${String(code)} signal=${String(signal)}`)
      )
    }

    function inspectLine(line: string): boolean {
      if (!line.startsWith(marker)) return false
      cleanup()
      resolveLine(parseJsonPayload<T>(line, marker))
      return true
    }

    function onData(chunk: Buffer): void {
      buffer += chunk.toString('utf8')
      let newline = buffer.indexOf('\n')
      while (newline !== -1) {
        const line = buffer.slice(0, newline).trim()
        buffer = buffer.slice(newline + 1)
        if (inspectLine(line)) return
        newline = buffer.indexOf('\n')
      }
    }

    stream.on('data', onData)
    child.on('exit', onExit)
  })
}

async function requestJson(
  url: string,
  init?: RequestInit
): Promise<{ status: number; body: unknown }> {
  const res = await fetch(url, init)
  return { status: res.status, body: (await res.json()) as unknown }
}

async function stopHost(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return
  child.kill('SIGTERM')
  let timeout: NodeJS.Timeout | undefined
  const [code] = (await Promise.race([
    once(child, 'exit'),
    new Promise<never>((_resolve, reject) => {
      timeout = setTimeout(() => reject(new Error('host did not exit after SIGTERM')), 10_000)
      timeout.unref()
    })
  ]).finally(() => {
    if (timeout !== undefined) clearTimeout(timeout)
  })) as [number | null, NodeJS.Signals | null]
  assert.equal(code, 0)
}

test(
  'managed serve host exposes proxy endpoints and shuts down cleanly',
  {
    skip: !integration,
    timeout: timeoutMs + 30_000
  },
  async () => {
    const hostEntry = resolve('dist/managed-serve-host.js')
    const child = spawn(process.execPath, [hostEntry], {
      cwd: resolve('.'),
      env: {
        ...process.env,
        QVAC_MODEL:
          process.env['QVAC_INTEGRATION_MODEL'] ?? process.env['QVAC_MODEL'] ?? 'qwen3.5-0.8b',
        QVAC_CTX_SIZE:
          process.env['QVAC_INTEGRATION_CTX_SIZE'] ?? process.env['QVAC_CTX_SIZE'] ?? '32768',
        QVAC_TOOLS: process.env['QVAC_TOOLS'] ?? 'true',
        QVAC_READY_TIMEOUT_MS: String(timeoutMs),
        QVAC_UPSTREAM_TIMEOUT_MS: process.env['QVAC_UPSTREAM_TIMEOUT_MS'] ?? '300000'
      },
      // fd 3 is the dedicated handshake channel; stdout carries only logs.
      stdio: ['pipe', 'pipe', 'pipe', 'pipe']
    })
    const stdin = child.stdin
    const stdout = child.stdout
    const stderr = child.stderr
    const handshakeStream = child.stdio[3] as Readable | null
    assert.ok(stdin !== null && stdout !== null && stderr !== null && handshakeStream !== null)
    stdin.end()
    const logs: Buffer[] = []
    stderr.on('data', (chunk: Buffer) => logs.push(chunk))
    stdout.on('data', (chunk: Buffer) => logs.push(chunk))

    try {
      const listeningPromise = waitForJsonLine<ListeningLine>(
        child,
        handshakeStream,
        'QVAC_LISTENING ',
        handshakeBudgetMs
      )
      const readyPromise = waitForJsonLine<ReadyLine>(child, stdout, 'QVAC_READY ', timeoutMs)
      let managedReady = false
      void readyPromise.then(
        () => {
          managedReady = true
        },
        () => undefined
      )

      const listening = await listeningPromise
      assert.equal(managedReady, false, 'handshake must not wait on managed readiness')
      assert.match(listening.proxyToken, /^[A-Za-z0-9_-]{43}$/)
      assert.match(listening.baseURL, /^http:\/\/127\.0\.0\.1:\d+\/v1$/)
      assert.equal(typeof listening.modelId, 'string')
      assert.equal(typeof listening.modelName, 'string')
      assert.equal('apiKey' in listening, false)

      // An unauthenticated caller is rejected by the proxy itself.
      const anonymous = await requestJson(`${listening.baseURL}/models`)
      assert.equal(anonymous.status, 401)

      const ready = await readyPromise
      assert.equal(ready.baseURL, listening.baseURL)
      assert.ok(ready.servePort > 0)
      assert.ok(ready.pid > 0)

      const authorization = { authorization: `Bearer ${listening.proxyToken}` }
      const models = await requestJson(`${listening.baseURL}/models`, { headers: authorization })
      assert.equal(models.status, 200)

      const chat = await requestJson(`${listening.baseURL}/chat/completions`, {
        method: 'POST',
        headers: { ...authorization, 'content-type': 'application/json' },
        body: JSON.stringify({
          model: listening.modelId,
          messages: [
            { role: 'user', content: [{ type: 'text', text: 'Reply with one short sentence.' }] }
          ],
          max_tokens: 16
        })
      })
      assert.equal(chat.status, 200)

      // The proxy token is the only secret observable from out here — the managed
      // serve key is generated inside the host and never handed out — and it must
      // not reach the host's log streams.
      const streamed = Buffer.concat(logs).toString('utf8')
      assert.doesNotMatch(streamed, new RegExp(listening.proxyToken))
    } catch (err) {
      assert.fail(
        `${err instanceof Error ? err.message : String(err)}\n${Buffer.concat(logs).toString('utf8')}`
      )
    } finally {
      await stopHost(child)
    }
  }
)
