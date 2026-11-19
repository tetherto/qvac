import { after, before, beforeEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { FastifyInstance } from 'fastify'
import type {
  FinetuneHandle,
  FinetuneProgress,
  FinetuneResult,
  FinetuneRunParams,
  FinetuneStopParams
} from '@qvac/sdk'
import { buildServer } from '@/serve/index'
import { openaiState } from '@/serve/extensions/openai/state'
import type { FineTuningOperations } from '@/serve/extensions/openai/routes/fine-tuning'
import { createFineTuningJobsStore } from '@/serve/extensions/openai/fine-tuning-jobs-store'
import { checkTrainingFile } from '@/serve/extensions/openai/schemas/fine-tuning'

const EXAMPLE = JSON.stringify({
  messages: [
    { role: 'user', content: 'Capital of Japan?' },
    { role: 'assistant', content: 'Tokyo.' }
  ]
})
const DATASET = `${EXAMPLE}\n${EXAMPLE}\n`

interface FakeRun {
  params: FinetuneRunParams
  progress: (p: Partial<FinetuneProgress>) => void
  finish: (result: FinetuneResult['status']) => void
  fail: (err: Error) => void
}

function fakeOperations(): FineTuningOperations & {
  runs: FakeRun[]
  controls: FinetuneStopParams[]
} {
  const runs: FakeRun[] = []
  const controls: FinetuneStopParams[] = []

  function run(params: FinetuneRunParams): FinetuneHandle {
    const queue: FinetuneProgress[] = []
    let done = false
    let wake: (() => void) | null = null
    let settle!: (r: FinetuneResult) => void
    let reject!: (e: Error) => void
    const result = new Promise<FinetuneResult>((res, rej) => {
      settle = res
      reject = rej
    })
    result.catch(() => {})
    function end(): void {
      done = true
      wake?.()
    }
    const progressStream = (async function* () {
      while (true) {
        if (queue.length > 0) yield queue.shift()!
        else if (done) return
        else await new Promise<void>((r) => (wake = r))
      }
    })()
    runs.push({
      params,
      progress(p) {
        queue.push({
          is_train: true,
          loss: 1.5,
          loss_uncertainty: null,
          accuracy: 0.5,
          accuracy_uncertainty: null,
          global_steps: 1,
          current_epoch: 0,
          current_batch: 1,
          total_batches: 4,
          elapsed_ms: 10,
          eta_ms: 1000,
          ...p
        })
        wake?.()
      },
      finish(status) {
        end()
        settle({ type: 'finetune', status })
      },
      fail(err) {
        end()
        reject(err)
      }
    })
    return { progressStream, result, requestId: `req-${runs.length}` }
  }

  // lunte-disable-next-line require-await
  async function control(params: FinetuneStopParams): Promise<FinetuneResult> {
    controls.push(params)
    const current = runs.at(-1)
    const status = params.operation === 'pause' ? 'PAUSED' : 'CANCELLED'
    current?.finish(status)
    return { type: 'finetune', status }
  }

  return { run, control, runs, controls }
}

async function waitFor(check: () => boolean, what: string): Promise<void> {
  for (let i = 0; i < 200; i++) {
    if (check()) return
    await new Promise((r) => setTimeout(r, 5))
  }
  assert.fail(`timed out waiting for ${what}`)
}

const CHAT = { modelSrc: 'x', sdkType: 'llm', endpointCategory: 'chat', config: {} }
const EMBED = { modelSrc: 'y', sdkType: 'embeddings', endpointCategory: 'embedding', config: {} }

async function server(enableAdmin: boolean): Promise<FastifyInstance> {
  const app = await buildServer({
    projectRoot: tmpdir(),
    port: 0,
    host: '127.0.0.1',
    quiet: true,
    extensions: ['openai'],
    enableAdmin
  })
  await app.ready()
  const { registry } = app.qvac
  registry.register('chat-a', CHAT)
  registry.setReady('chat-a', 'sdk-chat-a')
  registry.register('chat-b', CHAT)
  registry.setReady('chat-b', 'sdk-chat-b')
  registry.register('embed', EMBED)
  registry.setReady('embed', 'sdk-embed')
  return app
}

function upload(app: FastifyInstance, text: string, purpose = 'fine-tune'): string {
  return app.qvac.files.put({ data: Buffer.from(text), fileName: 'train.jsonl', purpose })
}

function code(res: { json: () => unknown }): string {
  return (res.json() as { error: { code: string } }).error.code
}

interface Job {
  id: string
  status: string
  model: string
  seed: number
  error: { code: string; message: string } | null
  hyperparameters: Record<string, unknown>
  finished_at: number | null
}

describe('fine-tuning without --enable-admin', () => {
  let app: FastifyInstance
  before(async () => {
    app = await server(false)
  })
  after(async () => {
    await app.close()
  })

  for (const [method, url] of [
    ['POST', '/v1/fine_tuning/jobs'],
    ['GET', '/v1/fine_tuning/jobs'],
    ['GET', '/v1/fine_tuning/jobs/ftjob-x'],
    ['GET', '/v1/fine_tuning/jobs/ftjob-x/content']
  ] as const) {
    it(`refuses ${method} ${url} with 403 admin_disabled`, async () => {
      const res = await app.inject(
        method === 'POST' ? { method, url, payload: {} } : { method, url }
      )
      assert.equal(res.statusCode, 403)
      assert.equal(code(res), 'admin_disabled')
    })
  }
})

describe('fine-tuning jobs', () => {
  let app: FastifyInstance
  let ops: ReturnType<typeof fakeOperations>
  before(async () => {
    app = await server(true)
  })
  after(async () => {
    await app.close()
  })
  beforeEach(async () => {
    // Cancel through the previous fake so its runs settle and the models free up.
    for (const job of openaiState(app.qvac).fineTuningJobs.all()) {
      if (['queued', 'running', 'paused'].includes(job.status)) {
        await app.inject({ method: 'POST', url: `/v1/fine_tuning/jobs/${job.id}/cancel` })
      }
    }
    ops = fakeOperations()
    openaiState(app.qvac).fineTuningOverride = ops
  })

  function create(payload: Record<string, unknown>) {
    return app.inject({ method: 'POST', url: '/v1/fine_tuning/jobs', payload })
  }

  async function createJob(extra: Record<string, unknown> = {}): Promise<Job> {
    const res = await create({ model: 'chat-a', training_file: upload(app, DATASET), ...extra })
    assert.equal(res.statusCode, 200, res.payload)
    return res.json() as Job
  }

  async function get(id: string): Promise<Job> {
    return (await app.inject({ method: 'GET', url: `/v1/fine_tuning/jobs/${id}` })).json() as Job
  }

  describe('validation', () => {
    const cases: Array<[string, () => Record<string, unknown>, number, string]> = [
      ['a missing training_file', () => ({ model: 'chat-a' }), 400, 'missing_training_file'],
      ['a missing model', () => ({ training_file: upload(app, DATASET) }), 400, 'missing_model'],
      [
        'an unknown model',
        () => ({ model: 'nope', training_file: upload(app, DATASET) }),
        404,
        'model_not_found'
      ],
      [
        'a non-chat model',
        () => ({ model: 'embed', training_file: upload(app, DATASET) }),
        400,
        'invalid_model_type'
      ],
      [
        'an unknown file',
        () => ({ model: 'chat-a', training_file: 'file-missing' }),
        404,
        'file_not_found'
      ],
      [
        'a file uploaded for another purpose',
        () => ({ model: 'chat-a', training_file: upload(app, DATASET, 'assistants') }),
        400,
        'invalid_file_purpose'
      ],
      [
        'a malformed training line',
        () => ({ model: 'chat-a', training_file: upload(app, `${EXAMPLE}\n{oops\n`) }),
        400,
        'invalid_training_file'
      ],
      [
        'a malformed validation file',
        () => ({
          model: 'chat-a',
          training_file: upload(app, DATASET),
          validation_file: upload(app, '{"messages":[]}')
        }),
        400,
        'invalid_validation_file'
      ],
      [
        'a dpo method',
        () => ({ model: 'chat-a', training_file: upload(app, DATASET), method: { type: 'dpo' } }),
        400,
        'unsupported_method'
      ],
      [
        'a numeric learning_rate_multiplier',
        () => ({
          model: 'chat-a',
          training_file: upload(app, DATASET),
          hyperparameters: { learning_rate_multiplier: 2 }
        }),
        400,
        'unsupported_parameter'
      ],
      [
        'integrations',
        () => ({
          model: 'chat-a',
          training_file: upload(app, DATASET),
          integrations: [{ type: 'wandb' }]
        }),
        400,
        'unsupported_parameter'
      ]
    ]

    for (const [name, payload, status, expected] of cases) {
      it(`answers ${status} ${expected} for ${name}`, async () => {
        const res = await create(payload())
        assert.equal(res.statusCode, status, res.payload)
        assert.equal(code(res), expected)
        assert.equal(ops.runs.length, 0)
      })
    }

    it('names the failing line', async () => {
      const res = await create({
        model: 'chat-a',
        training_file: upload(app, `${EXAMPLE}\n{oops\n`)
      })
      assert.match((res.json() as { error: { message: string } }).error.message, /line 2/)
    })

    it('rejects unknown body fields', async () => {
      const res = await create({ model: 'chat-a', training_file: upload(app, DATASET), x: 1 })
      assert.equal(res.statusCode, 400)
    })
  })

  it('maps the request onto SDK options and copies the datasets', async () => {
    const job = await createJob({
      validation_file: upload(app, DATASET),
      method: { type: 'supervised', supervised: { hyperparameters: { n_epochs: 2 } } },
      hyperparameters: { n_epochs: 9, batch_size: 4 },
      seed: 7,
      qvac: { learning_rate: 0.0001, lora_rank: 8, lora_modules: 'attn_q,attn_v' }
    })
    assert.equal(job.status, 'queued')
    assert.equal(job.seed, 7)
    assert.deepEqual(job.hyperparameters, {
      n_epochs: 2,
      batch_size: 'auto',
      learning_rate_multiplier: 'auto'
    })
    await waitFor(() => ops.runs.length === 1, 'the SDK run')
    const { params } = ops.runs[0]!
    assert.equal(params.modelId, 'sdk-chat-a')
    assert.equal(params.operation, 'start')
    const o = params.options
    assert.equal(o.numberOfEpochs, 2)
    assert.equal(o.batchSize, undefined)
    assert.equal(o.loraSeed, 7)
    assert.equal(o.learningRate, 0.0001)
    assert.equal(o.loraRank, 8)
    assert.equal(o.loraModules, 'attn_q,attn_v')
    assert.equal(o.assistantLossOnly, true)
    assert.equal(o.lrMin, 1e-8)
    assert.ok(existsSync(o.trainDatasetDir), 'training copy on disk')
    assert.equal(o.validation.type, 'dataset')
    ops.runs[0]!.finish('CANCELLED')
  })

  it('runs a job to success and serves the adapter', async () => {
    const job = await createJob()
    await waitFor(() => ops.runs.length === 1, 'the SDK run')
    const run = ops.runs[0]!

    run.progress({ global_steps: 1, loss: 2 })
    await waitFor(
      () => openaiState(app.qvac).fineTuningJobs.get(job.id)!.status === 'running',
      'running'
    )

    const busy = await create({ model: 'chat-a', training_file: upload(app, DATASET) })
    assert.equal(busy.statusCode, 409)
    assert.equal(code(busy), 'model_busy')

    const early = await app.inject({ method: 'GET', url: `/v1/fine_tuning/jobs/${job.id}/content` })
    assert.equal(early.statusCode, 409)
    assert.equal(code(early), 'job_not_succeeded')

    const out = run.params.options.outputParametersDir
    await mkdir(out, { recursive: true })
    await writeFile(join(out, 'trained-lora-adapter.gguf'), 'GGUF-bytes')
    run.finish('COMPLETED')
    await waitFor(
      () => openaiState(app.qvac).fineTuningJobs.get(job.id)!.status === 'succeeded',
      'success'
    )

    const done = await get(job.id)
    assert.ok(done.finished_at !== null)

    const content = await app.inject({
      method: 'GET',
      url: `/v1/fine_tuning/jobs/${job.id}/content`
    })
    assert.equal(content.statusCode, 200)
    assert.equal(content.payload, 'GGUF-bytes')
    assert.equal(content.headers['content-type'], 'application/octet-stream')

    const events = await app.inject({ method: 'GET', url: `/v1/fine_tuning/jobs/${job.id}/events` })
    const list = events.json() as {
      data: Array<{ type: string; message: string; data?: Record<string, number> }>
    }
    assert.equal(list.data[0]!.message, 'The job has successfully completed')
    const metrics = list.data.find((e) => e.type === 'metrics')
    assert.deepEqual(metrics?.data, {
      step: 1,
      epoch: 0,
      train_loss: 2,
      train_mean_token_accuracy: 0.5
    })

    const cancel = await app.inject({
      method: 'POST',
      url: `/v1/fine_tuning/jobs/${job.id}/cancel`
    })
    assert.equal(cancel.statusCode, 409)
    assert.equal(code(cancel), 'job_not_cancellable')

    const listed = await app.inject({ method: 'GET', url: '/v1/fine_tuning/jobs?limit=1' })
    assert.equal((listed.json() as { data: Job[] }).data[0]!.id, job.id)
  })

  it('reports a failed run with its error', async () => {
    const job = await createJob()
    await waitFor(() => ops.runs.length === 1, 'the SDK run')
    ops.runs[0]!.fail(new Error('out of memory'))
    await waitFor(
      () => openaiState(app.qvac).fineTuningJobs.get(job.id)!.status === 'failed',
      'failure'
    )
    const failed = await get(job.id)
    assert.equal(failed.error?.code, 'fine_tuning_failed')
    assert.match(failed.error!.message, /out of memory/)
    assert.equal(existsSync(ops.runs[0]!.params.options.trainDatasetDir), false)
  })

  it('pauses and resumes from the same options', async () => {
    const job = await createJob()
    await waitFor(() => ops.runs.length === 1, 'the SDK run')

    const notRunning = await app.inject({
      method: 'POST',
      url: `/v1/fine_tuning/jobs/${job.id}/pause`
    })
    assert.equal(code(notRunning), 'job_not_pausable')

    ops.runs[0]!.progress({})
    await waitFor(
      () => openaiState(app.qvac).fineTuningJobs.get(job.id)!.status === 'running',
      'running'
    )

    const paused = await app.inject({ method: 'POST', url: `/v1/fine_tuning/jobs/${job.id}/pause` })
    assert.equal(paused.statusCode, 200, paused.payload)
    assert.equal((paused.json() as Job).status, 'paused')
    assert.deepEqual(ops.controls, [{ modelId: 'sdk-chat-a', operation: 'pause' }])

    const busy = await create({ model: 'chat-a', training_file: upload(app, DATASET) })
    assert.equal(code(busy), 'model_busy')

    const resumed = await app.inject({
      method: 'POST',
      url: `/v1/fine_tuning/jobs/${job.id}/resume`
    })
    assert.equal(resumed.statusCode, 200, resumed.payload)
    assert.equal((resumed.json() as Job).status, 'queued')
    await waitFor(() => ops.runs.length === 2, 'the resumed run')
    assert.equal(ops.runs[1]!.params.operation, 'resume')
    assert.deepEqual(ops.runs[1]!.params.options, ops.runs[0]!.params.options)

    const again = await app.inject({ method: 'POST', url: `/v1/fine_tuning/jobs/${job.id}/resume` })
    assert.equal(code(again), 'job_not_resumable')
  })

  it('cancels a running job and drops its files', async () => {
    const job = await createJob()
    await waitFor(() => ops.runs.length === 1, 'the SDK run')
    const res = await app.inject({ method: 'POST', url: `/v1/fine_tuning/jobs/${job.id}/cancel` })
    assert.equal(res.statusCode, 200)
    assert.equal((res.json() as Job).status, 'cancelled')
    assert.deepEqual(ops.controls, [{ modelId: 'sdk-chat-a', operation: 'cancel' }])
    assert.equal(existsSync(ops.runs[0]!.params.options.trainDatasetDir), false)
  })

  it('cancels a paused job without calling the SDK', async () => {
    const job = await createJob()
    await waitFor(() => ops.runs.length === 1, 'the SDK run')
    ops.runs[0]!.finish('PAUSED')
    await waitFor(
      () => openaiState(app.qvac).fineTuningJobs.get(job.id)!.status === 'paused',
      'paused'
    )
    const res = await app.inject({ method: 'POST', url: `/v1/fine_tuning/jobs/${job.id}/cancel` })
    assert.equal((res.json() as Job).status, 'cancelled')
    assert.deepEqual(ops.controls, [])
  })

  it('admits one of two concurrent jobs on the same model', async () => {
    const [a, b] = await Promise.all([
      create({ model: 'chat-a', training_file: upload(app, DATASET) }),
      create({ model: 'chat-a', training_file: upload(app, DATASET) })
    ])
    assert.deepEqual([a.statusCode, b.statusCode].sort(), [200, 409])
  })

  it('runs jobs on different models side by side', async () => {
    await createJob()
    const other = await create({ model: 'chat-b', training_file: upload(app, DATASET) })
    assert.equal(other.statusCode, 200, other.payload)
  })

  for (const suffix of ['', '/events', '/cancel', '/pause', '/resume', '/content']) {
    it(`answers 404 job_not_found on ${suffix || 'retrieve'}`, async () => {
      const method = ['/cancel', '/pause', '/resume'].includes(suffix) ? 'POST' : 'GET'
      const res = await app.inject({ method, url: `/v1/fine_tuning/jobs/ftjob-none${suffix}` })
      assert.equal(res.statusCode, 404)
      assert.equal(code(res), 'job_not_found')
    })
  }

  it('lists its error codes in the OpenAPI document', async () => {
    const res = await app.inject({ method: 'GET', url: '/openapi.json' })
    const doc = res.json() as {
      paths: Record<string, Record<string, { responses: Record<string, { description: string }> }>>
    }
    const createOp = doc.paths['/v1/fine_tuning/jobs']!['post']!
    assert.match(createOp.responses['409']!.description, /model_busy/)
    assert.match(createOp.responses['403']!.description, /admin_disabled/)
    assert.ok(doc.paths['/v1/fine_tuning/jobs/{id}/content'])
  })
})

describe('checkTrainingFile', () => {
  it('accepts chat examples and blank lines', () => {
    assert.equal(checkTrainingFile(`${EXAMPLE}\n\n${EXAMPLE}`), null)
  })
  it('rejects an empty file', () => {
    assert.equal(checkTrainingFile('\n'), 'the file has no examples')
  })
  it('rejects an example without an assistant turn', () => {
    const line = JSON.stringify({ messages: [{ role: 'user', content: 'hi' }] })
    assert.match(checkTrainingFile(line)!, /line 1: no assistant message/)
  })
  it('rejects an unknown role', () => {
    const line = JSON.stringify({ messages: [{ role: 'bot', content: 'hi' }] })
    assert.match(checkTrainingFile(line)!, /messages\[0\]\.role/)
  })
})

describe('fine-tuning job events', () => {
  it('pages newest first with an after cursor', () => {
    const store = createFineTuningJobsStore()
    const job = store.create({
      model: 'm',
      sdkModelId: 's',
      dir: '/tmp/x',
      training_file: 'file-1',
      validation_file: null,
      hyperparameters: { n_epochs: 'auto', batch_size: 'auto', learning_rate_multiplier: 'auto' },
      seed: 1,
      suffix: null,
      metadata: null,
      sdkOptions: { trainDatasetDir: 'a', validation: { type: 'none' }, outputParametersDir: 'b' }
    })
    for (let i = 0; i < 5; i++) {
      store.addEvent(job, { level: 'info', type: 'message', message: `m${i}` })
    }
    const first = store.events(job, { limit: 2 })
    assert.deepEqual(
      first.data.map((e) => e.message),
      ['m4', 'm3']
    )
    assert.equal(first.has_more, true)
    const next = store.events(job, { limit: 2, after: first.data[1]!.id })
    assert.deepEqual(
      next.data.map((e) => e.message),
      ['m2', 'm1']
    )
  })
})
