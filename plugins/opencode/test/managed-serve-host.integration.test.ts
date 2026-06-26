import assert from 'node:assert/strict'
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { once } from 'node:events'
import { resolve } from 'node:path'
import { test } from 'node:test'

interface ListeningLine {
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

function parseJsonPayload<T> (line: string, marker: string): T {
  const raw = line.slice(marker.length).trim()
  return JSON.parse(raw) as T
}

function waitForJsonLine<T> (
  child: ChildProcessWithoutNullStreams,
  marker: string,
  timeout: number
): Promise<T> {
  return new Promise((resolveLine, reject) => {
    let buffer = ''
    const timer = setTimeout(() => {
      cleanup()
      reject(new Error(`timed out waiting for ${marker}`))
    }, timeout)

    function cleanup (): void {
      clearTimeout(timer)
      child.stdout.off('data', onData)
      child.off('exit', onExit)
    }

    function onExit (code: number | null, signal: NodeJS.Signals | null): void {
      cleanup()
      reject(new Error(`host exited before ${marker}: code=${String(code)} signal=${String(signal)}`))
    }

    function inspectLine (line: string): boolean {
      if (!line.startsWith(marker)) return false
      cleanup()
      resolveLine(parseJsonPayload<T>(line, marker))
      return true
    }

    function onData (chunk: Buffer): void {
      buffer += chunk.toString('utf8')
      let newline = buffer.indexOf('\n')
      while (newline !== -1) {
        const line = buffer.slice(0, newline).trim()
        buffer = buffer.slice(newline + 1)
        if (inspectLine(line)) return
        newline = buffer.indexOf('\n')
      }
    }

    child.stdout.on('data', onData)
    child.on('exit', onExit)
  })
}

async function requestJson (url: string, init?: RequestInit): Promise<{ status: number, body: unknown }> {
  const res = await fetch(url, init)
  return { status: res.status, body: await res.json() as unknown }
}

async function stopHost (child: ChildProcessWithoutNullStreams): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return
  child.kill('SIGTERM')
  let timeout: NodeJS.Timeout | undefined
  const [code] = await Promise.race([
    once(child, 'exit'),
    new Promise<never>((_resolve, reject) => {
      timeout = setTimeout(() => reject(new Error('host did not exit after SIGTERM')), 10_000)
      timeout.unref()
    })
  ]).finally(() => {
    if (timeout !== undefined) clearTimeout(timeout)
  }) as [number | null, NodeJS.Signals | null]
  assert.equal(code, 0)
}

test('managed serve host exposes proxy endpoints and shuts down cleanly', {
  skip: !integration,
  timeout: timeoutMs + 30_000
}, async () => {
  const hostEntry = resolve('dist/managed-serve-host.js')
  const child = spawn(process.execPath, [hostEntry], {
    cwd: resolve('.'),
    env: {
      ...process.env,
      QVAC_MODEL: process.env['QVAC_INTEGRATION_MODEL'] ?? process.env['QVAC_MODEL'] ?? 'qwen3.5-0.8b',
      QVAC_CTX_SIZE: process.env['QVAC_INTEGRATION_CTX_SIZE'] ?? process.env['QVAC_CTX_SIZE'] ?? '32768',
      QVAC_TOOLS: process.env['QVAC_TOOLS'] ?? 'true',
      QVAC_READY_TIMEOUT_MS: String(timeoutMs),
      QVAC_UPSTREAM_TIMEOUT_MS: process.env['QVAC_UPSTREAM_TIMEOUT_MS'] ?? '300000'
    },
    stdio: ['pipe', 'pipe', 'pipe']
  })
  child.stdin.end()
  const stderr: Buffer[] = []
  child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk))

  try {
    const listeningPromise = waitForJsonLine<ListeningLine>(child, 'QVAC_LISTENING ', 10_000)
    const readyPromise = waitForJsonLine<ReadyLine>(child, 'QVAC_READY ', timeoutMs)
    void readyPromise.catch(() => undefined)

    const listening = await listeningPromise
    assert.match(listening.baseURL, /^http:\/\/127\.0\.0\.1:\d+\/v1$/)
    assert.equal(typeof listening.modelId, 'string')
    assert.equal(typeof listening.modelName, 'string')

    const ready = await readyPromise
    assert.equal(ready.baseURL, listening.baseURL)
    assert.ok(ready.servePort > 0)
    assert.ok(ready.pid > 0)

    const models = await requestJson(`${listening.baseURL}/models`)
    assert.equal(models.status, 200)

    const chat = await requestJson(`${listening.baseURL}/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: listening.modelId,
        messages: [{ role: 'user', content: [{ type: 'text', text: 'Reply with one short sentence.' }] }],
        max_tokens: 16
      })
    })
    assert.equal(chat.status, 200)
  } catch (err) {
    const logs = Buffer.concat(stderr).toString('utf8')
    assert.fail(`${err instanceof Error ? err.message : String(err)}\n${logs}`)
  } finally {
    await stopHost(child)
  }
})
