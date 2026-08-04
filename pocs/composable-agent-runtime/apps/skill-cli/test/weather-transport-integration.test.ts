import { expect, test } from 'bun:test'
import { spawn as spawnChild } from 'node:child_process'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import tls from 'node:tls'
import { fileURLToPath } from 'node:url'
import { requestPinnedHttps } from '../lib/weather-transport.ts'

interface ServerObservation {
  readonly sni: string | false | null
  readonly remoteAddress?: string
  request?: string
  closed: boolean
}

test('pinned HTTPS preserves TCP address and TLS hostname in Node and Bare', async () => {
  const fixtureRoot = path.join(
    path.dirname(fileURLToPath(import.meta.url)),
    'fixtures'
  )
  const certPath = path.join(fixtureRoot, 'weather-tls-cert.pem')
  const keyPath = path.join(fixtureRoot, 'weather-tls-key.pem')
  const [cert, key] = await Promise.all([
    fs.readFile(certPath),
    fs.readFile(keyPath)
  ])
  const observations: ServerObservation[] = []
  const sockets = new Set<tls.TLSSocket>()
  const server = tls.createServer({ cert, key }, (socket) => {
    sockets.add(socket)
    const observation: ServerObservation = {
      sni: socket.servername,
      ...(socket.remoteAddress
        ? { remoteAddress: socket.remoteAddress }
        : {}),
      closed: false
    }
    observations.push(observation)
    let request = ''
    socket.on('data', (chunk) => {
      request += chunk.toString()
      if (!request.includes('\r\n\r\n')) return
      observation.request = request
      if (request.startsWith('GET /cancel ')) return
      const body = request.startsWith('GET /success ')
        ? 'bare-pinned-ok'
        : 'node-pinned-ok'
      socket.end(
        `HTTP/1.1 200 OK\r\nContent-Length: ${Buffer.byteLength(body)}\r\nConnection: close\r\n\r\n${body}`
      )
    })
    socket.once('close', () => {
      observation.closed = true
      sockets.delete(socket)
    })
  })
  await listen(server)
  const address = server.address()
  if (!address || typeof address === 'string') {
    throw new Error('controlled TLS server did not bind TCP')
  }

  try {
    const node = await requestPinnedHttps({
      url: new URL('https://wttr.in/node'),
      address: { address: '127.0.0.1', family: 4 },
      port: address.port,
      ca: cert,
      signal: new AbortController().signal,
      maxResponseBytes: 8_192
    })
    expect(node).toEqual({
      status: 200,
      headers: { location: undefined },
      body: 'node-pinned-ok'
    })

    const bare = await runBareProbe({
      mode: 'success',
      port: address.port,
      ca: certPath
    })
    expect(bare).toEqual({
      status: 'success',
      response: {
        status: 200,
        headers: {},
        body: 'bare-pinned-ok'
      }
    })

    const cancelled = await runBareProbe({
      mode: 'cancel',
      port: address.port,
      ca: certPath
    })
    expect(cancelled).toMatchObject({
      status: 'error',
      name: 'AbortError'
    })

    const wrongIdentity = await runBareProbe({
      mode: 'wrong-identity',
      port: address.port,
      ca: certPath
    })
    expect(wrongIdentity).toMatchObject({ status: 'error' })
    expect(wrongIdentity.message).toMatch(/certificate|verify|hostname|identity/i)

    await expect(
      requestPinnedHttps({
        url: new URL('https://wrong.example/node'),
        address: { address: '127.0.0.1', family: 4 },
        port: address.port,
        ca: cert,
        signal: new AbortController().signal,
        maxResponseBytes: 8_192
      })
    ).rejects.toThrow(/certificate|hostname|altname/i)

    await waitFor(() =>
      observations.some(
        (observation) =>
          observation.request?.startsWith('GET /cancel ') &&
          observation.closed
      )
    )
    const successful = observations.filter(
      (observation) =>
        observation.request?.startsWith('GET /node ') ||
        observation.request?.startsWith('GET /success ')
    )
    expect(successful).toHaveLength(2)
    for (const observation of successful) {
      expect(observation.sni).toBe('wttr.in')
      expect(observation.remoteAddress).toBe('127.0.0.1')
      expect(observation.request).toContain(`Host: wttr.in:${address.port}`)
    }
  } finally {
    for (const socket of sockets) socket.destroy()
    await close(server)
  }
}, 15_000)

async function runBareProbe(input: {
  readonly mode: 'success' | 'cancel' | 'wrong-identity'
  readonly port: number
  readonly ca: string
}) {
  const probe = fileURLToPath(
    new URL('./weather-transport-bare-probe.ts', import.meta.url)
  )
  const outputRoot = await fs.mkdtemp(
    path.join(os.tmpdir(), 'qvac-weather-transport-probe-')
  )
  const outputPath = path.join(outputRoot, 'result.json')
  const child = spawnChild(
    'bare',
    [
      probe,
      `--mode=${input.mode}`,
      `--port=${input.port}`,
      `--ca=${input.ca}`,
      `--output=${outputPath}`
    ],
    {
      cwd: path.dirname(probe),
      stdio: ['ignore', 'pipe', 'pipe']
    }
  )
  let stdout = ''
  let stderr = ''
  child.stdout.on('data', (chunk) => {
    stdout += chunk.toString()
  })
  child.stderr.on('data', (chunk) => {
    stderr += chunk.toString()
  })
  const exitCode = await new Promise<number | null>((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      reject(
        new Error(
          `Bare transport probe timed out: ${stderr.trim() || stdout.trim()}`
        )
      )
    }, 5_000)
    child.once('error', (error) => {
      clearTimeout(timer)
      reject(error)
    })
    child.once('exit', (code) => {
      clearTimeout(timer)
      resolve(code)
    })
  }).finally(() => {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGKILL')
    }
  })
  if (exitCode !== 0) {
    throw new Error(
      `Bare transport probe failed with exit ${exitCode}: ${stderr.trim()}`
    )
  }
  const output =
    stdout.trim() ||
    await fs.readFile(outputPath, 'utf8').catch(() => '')
  await fs.rm(outputRoot, { recursive: true, force: true })
  if (!output) {
    throw new Error(
      `Bare transport probe exited without output: ${stderr.trim()}`
    )
  }
  return JSON.parse(output) as {
    readonly status: string
    readonly name?: string
    readonly message?: string
    readonly response?: object
  }
}

function listen(server: tls.Server) {
  return new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      server.removeListener('error', reject)
      resolve()
    })
  })
}

function close(server: tls.Server) {
  return new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error) reject(error)
      else resolve()
    })
  })
}

async function waitFor(predicate: () => boolean) {
  const deadline = Date.now() + 2_000
  while (!predicate()) {
    if (Date.now() >= deadline) {
      throw new Error('timed out waiting for TLS transport state')
    }
    await Bun.sleep(5)
  }
}
