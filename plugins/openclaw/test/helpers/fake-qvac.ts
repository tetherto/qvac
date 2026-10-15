import { once } from 'node:events'
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// Stand-in for `qvac serve`: binds the requested port, reports it on --ready-fd,
// and answers /v1/models and /v1/chat/completions for the key it was given.
// Spawned verbatim as a custom `qvacCommand`, so it needs a POSIX shebang and
// exec bit — callers skip on Windows.
const FAKE_QVAC = `#!/usr/bin/env node
const fs = require('node:fs')
const http = require('node:http')
const args = process.argv.slice(2)
function arg (name) { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined }
const behavior = process.env.FAKE_QVAC_BEHAVIOR || 'healthy'
const readyFd = arg('--ready-fd')
const apiKey = arg('--api-key') || (arg('--api-key-file') && fs.readFileSync(arg('--api-key-file'), 'utf8').trim())

if (process.env.FAKE_QVAC_ARGV_FILE) fs.writeFileSync(process.env.FAKE_QVAC_ARGV_FILE, JSON.stringify(args))
if (behavior === 'no-ready-fd' && readyFd !== undefined) {
  console.error("error: unknown option '--ready-fd'")
  process.exit(1)
}

const server = http.createServer((req, res) => {
  if (req.headers.authorization !== 'Bearer ' + apiKey) { res.statusCode = 401; res.end(); return }
  res.setHeader('content-type', 'application/json')
  if (req.url === '/v1/models') {
    res.end(JSON.stringify({ object: 'list', data: [{ id: arg('--model'), object: 'model' }] }))
    return
  }
  if (req.method === 'POST' && req.url === '/v1/chat/completions') {
    let body = ''
    req.on('data', (chunk) => { body += chunk })
    req.on('end', () => {
      const base = { id: 'chatcmpl-fake', created: 0, model: arg('--model') }
      const usage = { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 }
      if (!JSON.parse(body || '{}').stream) {
        res.end(JSON.stringify({ ...base, object: 'chat.completion', usage,
          choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: 'answer from the real serve' } }] }))
        return
      }
      res.setHeader('content-type', 'text/event-stream')
      const chunk = (choice) => 'data: ' + JSON.stringify({ ...base, object: 'chat.completion.chunk', choices: [choice] }) + '\\n\\n'
      res.write(chunk({ index: 0, delta: { role: 'assistant', content: 'answer from the real serve' }, finish_reason: null }))
      res.write(chunk({ index: 0, delta: {}, finish_reason: 'stop' }))
      res.end('data: [DONE]\\n\\n')
    })
    return
  }
  res.statusCode = 404
  res.end()
})
server.on('error', (error) => { console.error(String(error)); process.exit(1) })
server.listen(Number(arg('--port') || 0), arg('--host') || '127.0.0.1', () => {
  if (readyFd === undefined) return
  const pid = behavior === 'wrong-pid' ? process.pid + 1 : process.pid
  fs.writeSync(Number(readyFd), 'QVAC_SERVE_READY ' + JSON.stringify({ port: server.address().port, pid }) + '\\n')
  fs.closeSync(Number(readyFd))
})
process.on('SIGTERM', () => process.exit(0))
`

export const fakeQvacSkip = process.platform === 'win32'

export function makeFakeQvac(): { command: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'qvac-openclaw-fake-'))
  const command = join(dir, 'fake-qvac.cjs')
  writeFileSync(command, FAKE_QVAC, 'utf8')
  chmodSync(command, 0o755)
  return { command, cleanup: () => rmSync(dir, { recursive: true, force: true }) }
}

export function setFakeQvacEnv(name: 'BEHAVIOR' | 'ARGV_FILE', value: string | undefined): void {
  const key = `FAKE_QVAC_${name}`
  if (value === undefined) delete process.env[key]
  else process.env[key] = value
}

export interface Squatter {
  readonly server: Server
  readonly port: number
  readonly requests: Array<{ url: string; authorization: string | undefined }>
  close(): Promise<void>
}

// Another local account holding a port: answers 2xx to everything and records
// whatever reaches it.
export async function startSquatter(port = 0): Promise<Squatter> {
  const requests: Squatter['requests'] = []
  const server = createServer((req, res) => {
    requests.push({ url: req.url ?? '', authorization: req.headers.authorization })
    req.resume()
    res.setHeader('content-type', 'application/json')
    res.end(JSON.stringify({ object: 'list', data: [{ id: 'squatted' }] }))
  })
  server.listen(port, '127.0.0.1')
  await once(server, 'listening')
  return {
    server,
    port: (server.address() as AddressInfo).port,
    requests,
    close: () => new Promise((resolve) => server.close(() => resolve()))
  }
}
