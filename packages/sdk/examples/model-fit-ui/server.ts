/**
 * Demo: assessModelFit's verdict next to what actually happens.
 *
 * Serves a page listing catalog models with two buttons. "Estimate" calls
 * `assessModelFit` — no weights, no load. "Run" loads the model for real and
 * runs one completion, so the verdict can be checked against the outcome.
 *
 * Expect `likely-too-large` to mean "will not go well" rather than "will not
 * load": an OS with swap usually runs it anyway. Measured here, a 1.7B called
 * too-large took 519s against 7.8s for a 600M called fits — same 32 tokens.
 * The verdict is about the interactive budget, not about whether the load
 * throws.
 *
 * Memory is read through `getSystemResources`, not `process.memoryUsage()`:
 * inference runs in a spawned worker, so this process's own RSS never sees the
 * model. The numbers are therefore system-wide and include whatever else the
 * machine is doing — fine for a demo, not a measurement.
 *
 * Run (Node or Bun, not Bare — this uses node:http):
 *   bun run examples/model-fit-ui/server.ts
 *   node dist/examples/model-fit-ui/server.js
 */

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { readFileSync } from 'node:fs'
import {
  assessModelFit,
  getSystemResources,
  loadModel,
  unloadModel,
  completion,
  close,
  QWEN3_600M_INST_Q4,
  QWEN3_1_7B_INST_Q4,
  QWEN3_4B_INST_Q4_K_M,
  QWEN3_8B_INST_Q4_K_M,
  QWEN3_8_27B_MULTIMODAL_UD_Q8_K_XL
} from '@qvac/sdk'

const PORT = 8712

// A ladder ending well past what a laptop has, so one screen shows every
// verdict. The 27B at Q8 is here to be refused.
const CATALOG = [
  QWEN3_600M_INST_Q4,
  QWEN3_1_7B_INST_Q4,
  QWEN3_4B_INST_Q4_K_M,
  QWEN3_8B_INST_Q4_K_M,
  QWEN3_8_27B_MULTIMODAL_UD_Q8_K_XL
]

const PAGE_PATH = new URL('index.html', import.meta.url)

// Read per request, not once at startup: editing the page and reloading is the
// normal way to poke at this, and a cached copy makes that silently not work.
function page() {
  return readFileSync(PAGE_PATH)
}

function byName(name: string) {
  const model = CATALOG.find((entry) => entry.name === name)
  if (!model) throw new Error(`unknown model: ${name}`)
  return model
}

async function systemUsedBytes() {
  const resources = await getSystemResources({ sample: true })
  const used = resources.sample?.memory.usedBytes
  return used?.status === 'supported' ? used.value : undefined
}

function readBody(request: IncomingMessage) {
  return new Promise<Record<string, unknown>>((resolve, reject) => {
    const chunks: Buffer[] = []
    request.on('data', (chunk: Buffer) => chunks.push(chunk))
    request.on('error', reject)
    request.on('end', () => {
      try {
        resolve(chunks.length > 0 ? JSON.parse(Buffer.concat(chunks).toString()) : {})
      } catch (error) {
        reject(error)
      }
    })
  })
}

function sendJson(response: ServerResponse, status: number, payload: unknown) {
  const body = JSON.stringify(payload)
  response.writeHead(status, { 'content-type': 'application/json' })
  response.end(body)
}

async function estimate(body: Record<string, unknown>) {
  const names = Array.isArray(body['names']) ? (body['names'] as string[]) : []
  const contextTokens = Number(body['contextTokens'] ?? 8192)
  const workload = { kind: 'llm', contextTokens } as const

  return assessModelFit({
    models: names.map((name) => ({ model: byName(name), workload })),
    // Declared for aggregation only. 'sequential' counts the largest operation
    // peak; 'concurrent' counts one per model.
    execution: 'sequential',
    policy: 'interactive-v1'
  })
}

/** Loads for real, generates a few tokens, unloads. The reality check. */
async function run(body: Record<string, unknown>) {
  const model = byName(String(body['name']))
  const contextTokens = Number(body['contextTokens'] ?? 8192)
  const startedAt = Date.now()
  const before = await systemUsedBytes()

  let modelId: string | undefined
  try {
    modelId = await loadModel({
      modelSrc: model,
      modelType: 'llm',
      modelConfig: { ctx_size: contextTokens }
    })
    const afterLoad = await systemUsedBytes()

    const result = completion({
      modelId,
      history: [{ role: 'user', content: 'Reply with one short sentence about maps.' }],
      stream: false,
      generationParams: { predict: 32 }
    })
    const final = await result.final

    return {
      ok: true,
      elapsedMs: Date.now() - startedAt,
      systemUsedBeforeBytes: before,
      systemUsedAfterLoadBytes: afterLoad,
      backendDevice: final.stats?.backendDevice,
      sample: final.contentText.trim().slice(0, 120)
    }
  } catch (error) {
    // The interesting negative case: the estimate said too large, and the load
    // proves it. Report it as a result, not a crash.
    return {
      ok: false,
      elapsedMs: Date.now() - startedAt,
      systemUsedBeforeBytes: before,
      error: error instanceof Error ? error.message : String(error)
    }
  } finally {
    if (modelId) await unloadModel({ modelId }).catch(() => {})
  }
}

const server = createServer((request, response) => {
  const url = request.url ?? '/'

  if (request.method === 'GET' && (url === '/' || url.startsWith('/?'))) {
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    response.end(page())
    return
  }

  if (request.method === 'GET' && url === '/api/models') {
    sendJson(
      response,
      200,
      CATALOG.map((model) => ({ name: model.name, expectedSize: model.expectedSize }))
    )
    return
  }

  if (request.method === 'POST' && (url === '/api/assess' || url === '/api/run')) {
    readBody(request)
      .then(async (body) => (url === '/api/assess' ? await estimate(body) : await run(body)))
      .then((payload) => sendJson(response, 200, payload))
      .catch((error: unknown) => {
        sendJson(response, 500, { error: error instanceof Error ? error.message : String(error) })
      })
    return
  }

  sendJson(response, 404, { error: 'not found' })
})

server.listen(PORT, () => {
  console.log(`▸ assessModelFit demo on http://localhost:${PORT}`)
  console.log('▸ "Run" downloads weights on first use — the 8B is ~4.7 GiB.')
})

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    server.close()
    close()
      .catch(() => {})
      .finally(() => process.exit(0))
  })
}
