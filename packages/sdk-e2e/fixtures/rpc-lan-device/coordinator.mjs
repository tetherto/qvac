import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { collectBuildMetadata } from './build-metadata.mjs'
import { describeError } from './diagnostics.mjs'
import {
  startRpcServer,
  stopRpcServer,
  discoverRpcServers,
  rpcServerStatusStream,
  subscribeServerLogs,
  loadModel,
  completion,
  unloadModel,
  getRpcDeviceMap,
  close
} from '@qvac/sdk'

const model = process.env.QVAC_RPC_LAN_MODEL_PATH
if (!model || !fs.existsSync(model))
  throw new Error('Set QVAC_RPC_LAN_MODEL_PATH to a cached GGUF model')
const topic = `qvac-rpc-lan-device-${Date.now()}`
const sdk = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../sdk')
const metadata = {
  ...(await collectBuildMetadata(sdk)),
  model: { filename: path.basename(model), bytes: fs.statSync(model).size }
}
const lanAddresses = process.env.QVAC_RPC_LAN_ADDRESSES?.split(',')
const nativeLogs = []
const health = []
const unsubscribeLogs = subscribeServerLogs((record) => {
  const captured = { ...record, message: record.message.slice(0, 1024), at: Date.now() }
  nativeLogs.push(captured)
  if (nativeLogs.length > 64) nativeLogs.shift()
  console.log('NATIVE', JSON.stringify(captured))
})
const statusController = new AbortController()
void (async () => {
  for await (const status of rpcServerStatusStream({}, { signal: statusController.signal })) {
    const captured = {
      ...status,
      reason: status.reason.slice(0, 512),
      error: status.error && describeError(status.error),
      at: Date.now()
    }
    health.push(captured)
    if (health.length > 16) health.shift()
    console.log('HEALTH', JSON.stringify(captured))
  }
})().catch((error) => {
  if (!statusController.signal.aborted) console.error('HEALTH_STREAM_FAILED', error)
})
const server = await startRpcServer({
  allowNonLoopbackHost: true,
  discoveryTopic: topic,
  host: process.env.QVAC_RPC_LAN_HOST,
  lanAddresses
})
const host = server.url.split(':')[0]
const tasks = new Map([
  ['android', []],
  ['ios', []]
])
const results = []
const peers = new Map()
let id = 0
async function json(request) {
  const chunks = []
  let size = 0
  for await (const chunk of request) {
    if ((size += chunk.length) > 262144) throw new Error('Request too large')
    chunks.push(chunk)
  }
  return JSON.parse(Buffer.concat(chunks).toString())
}
function reply(response, value, status = 200) {
  response.writeHead(status, { 'Content-Type': 'application/json' })
  response.end(JSON.stringify(value))
}
const api = http.createServer(async (request, response) => {
  try {
    const url = new URL(request.url, 'http://localhost')
    if (url.pathname === '/info')
      return reply(response, {
        topic,
        server,
        peers: Object.fromEntries(peers),
        metadata,
        health,
        nativeLogs
      })
    if (url.pathname === '/results') return reply(response, results)
    if (url.pathname === '/enqueue' && request.method === 'POST') {
      const task = await json(request)
      const queue = tasks.get(task.device)
      if (!queue) throw new Error('Unknown device')
      if (queue.length >= 16) throw new Error('Task queue full')
      const next = { topic, ...task, id: ++id }
      queue.push(next)
      return reply(response, next)
    }
    if (url.pathname.startsWith('/task/')) {
      const device = url.pathname.split('/')[2]
      peers.set(device, {
        address: request.socket.remoteAddress,
        lastSeen: new Date().toISOString()
      })
      const task = tasks.get(device)?.shift()
      return task ? reply(response, task) : response.writeHead(204).end()
    }
    if (url.pathname.startsWith('/result/') && request.method === 'POST') {
      const [, , device, taskId] = url.pathname.split('/')
      const result = { device, id: Number(taskId), ...(await json(request)) }
      results.push(result)
      if (results.length > 200) results.shift()
      console.log('RESULT', JSON.stringify(result))
      return reply(response, 'recorded')
    }
    if (url.pathname === '/model.gguf') {
      const size = fs.statSync(model).size
      const range = /^bytes=(\d+)-(\d*)$/.exec(request.headers.range ?? '')
      const start = range ? Number(range[1]) : 0
      const end = range?.[2] ? Number(range[2]) : size - 1
      if (start < 0 || end >= size || end < start) return response.writeHead(416).end()
      response.writeHead(range ? 206 : 200, {
        'Content-Type': 'application/octet-stream',
        'Content-Length': end - start + 1,
        'Accept-Ranges': 'bytes',
        ...(range && { 'Content-Range': `bytes ${start}-${end}/${size}` })
      })
      if (request.method === 'HEAD') return response.end()
      const stream = fs.createReadStream(model, { start, end })
      stream.on('error', () => response.destroy())
      response.on('close', () => stream.destroy())
      return stream.pipe(response)
    }
    if (url.pathname === '/discover')
      return reply(response, await discoverRpcServers({ topic, timeoutMs: 5000, lanAddresses }))
    if (url.pathname === '/infer' && request.method === 'POST') {
      const options = await json(request)
      const started = Date.now()
      const servers = (
        await discoverRpcServers({
          topic,
          timeoutMs: 5000,
          lanAddresses: options.lanAddresses ?? lanAddresses
        })
      ).filter(({ url }) => !options.remoteOnly || url !== server.url)
      if (!servers.length) throw new Error('No remote servers discovered')
      const devices = getRpcDeviceMap(servers).filter(
        (device) => device.totalMemory > 0 && device.freeMemory > 0
      )
      if (!devices.length) throw new Error('No usable devices')
      const modelId = await loadModel({
        modelSrc: model,
        modelType: 'llamacpp-completion',
        modelConfig: {
          ctx_size: 512,
          predict: 16,
          device: 'gpu',
          verbosity: 2,
          'rpc-servers': servers.map(({ url }) => url).join(','),
          devices: devices.map(({ alias }) => alias).join(','),
          'split-mode': 'layer',
          'tensor-split': devices.map(() => '1').join(',')
        }
      })
      try {
        const run = completion({
          modelId,
          history: [{ role: 'user', content: 'Reply with the single word hello.' }],
          generationParams: { temp: 0, seed: 1, predict: 16 },
          stream: true
        })
        let text = ''
        for await (const token of run.tokenStream) text += token
        if (!text.toLowerCase().includes('hello')) throw new Error(`Unexpected completion: ${text}`)
        return reply(response, {
          text,
          servers,
          devices,
          metadata,
          executionEvidence: {
            status: 'pending-external-verification',
            required:
              'Native server graph or tensor execution records tied to the selected endpoints',
            nativeLogs: nativeLogs.filter(({ at }) => at >= started)
          }
        })
      } finally {
        await unloadModel({ modelId, autoClose: false })
      }
    }
    reply(response, 'not found', 404)
  } catch (error) {
    reply(response, { error: String(error), stack: error.stack }, 500)
  }
})
await new Promise((resolve) => api.listen(19764, host, resolve))
console.log('READY', JSON.stringify({ coordinator: `http://${host}:19764`, topic, server }))
async function stop() {
  statusController.abort()
  unsubscribeLogs()
  api.closeAllConnections()
  api.close()
  await stopRpcServer({ serverId: server.serverId })
  await close()
}
process.once('SIGTERM', () => {
  void stop().finally(() => process.exit())
})
process.once('SIGINT', () => {
  void stop().finally(() => process.exit())
})
