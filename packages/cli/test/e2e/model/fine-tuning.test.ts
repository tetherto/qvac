import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import type { FastifyInstance } from 'fastify'
import { useModelServer } from '../helpers/server.js'
import { multipart } from '../helpers/http.js'

const ALIAS = 'finetune-llm'
const FIXTURES = fileURLToPath(new URL('../../fixtures/fine-tuning/', import.meta.url))

const CONFIG = {
  serve: {
    models: {
      [ALIAS]: { model: 'QWEN3_600M_INST_Q4', preload: true, config: { ctx_size: 512 } }
    }
  }
}

interface Job {
  id: string
  status: string
  error: { message: string } | null
}

async function upload(app: FastifyInstance, file: string): Promise<string> {
  const data = await readFile(FIXTURES + file)
  const res = await app.inject({
    method: 'POST',
    url: '/v1/files',
    ...multipart([
      { name: 'file', filename: file, contentType: 'application/jsonl', data },
      { name: 'purpose', value: 'fine-tune' }
    ])
  })
  assert.equal(res.statusCode, 200, res.payload)
  return (res.json() as { id: string }).id
}

async function waitForEnd(app: FastifyInstance, id: string): Promise<Job> {
  const deadline = Date.now() + 10 * 60_000
  while (Date.now() < deadline) {
    const job = (
      await app.inject({ method: 'GET', url: `/v1/fine_tuning/jobs/${id}` })
    ).json() as Job
    if (!['queued', 'running'].includes(job.status)) return job
    await new Promise((r) => setTimeout(r, 1000))
  }
  assert.fail(`job ${id} did not finish in time`)
}

describe('qvac serve: fine-tuning jobs', () => {
  const server = useModelServer(CONFIG, { enableAdmin: true })

  it('trains a LoRA adapter from uploaded files and serves it', async () => {
    const app = server()
    const created = await app.inject({
      method: 'POST',
      url: '/v1/fine_tuning/jobs',
      payload: {
        model: ALIAS,
        training_file: await upload(app, 'train.jsonl'),
        validation_file: await upload(app, 'validation.jsonl'),
        method: { type: 'supervised', supervised: { hyperparameters: { n_epochs: 1 } } },
        seed: 42,
        qvac: { learning_rate: 0.0001 }
      }
    })
    assert.equal(created.statusCode, 200, created.payload)
    const { id } = created.json() as Job

    const job = await waitForEnd(app, id)
    assert.equal(job.status, 'succeeded', job.error?.message)

    const events = await app.inject({
      method: 'GET',
      url: `/v1/fine_tuning/jobs/${id}/events?limit=100`
    })
    const { data } = events.json() as { data: Array<{ type: string; data?: { step: number } }> }
    assert.ok(
      data.some((e) => e.type === 'metrics' && e.data !== undefined && e.data.step >= 0),
      'expected training metrics'
    )

    const content = await app.inject({ method: 'GET', url: `/v1/fine_tuning/jobs/${id}/content` })
    assert.equal(content.statusCode, 200)
    assert.equal(content.rawPayload.subarray(0, 4).toString('latin1'), 'GGUF')
  })
})
