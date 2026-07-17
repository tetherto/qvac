import test from 'brittle'
import { createErrorResponse } from '@qvac/inference/surface'
import { contractValidate } from './utils/contract-validator'

// Contract-artifact checks: validate representative payloads against the
// committed contract/schema.json (what generated clients consume). The Zod
// round-trip checks for these same schemas live in @qvac/inference's suite; here
// we only assert the exported JSON Schema contract stays faithful to them.

test('contract completionStream.response: validates streaming event chunks', (t) => {
  const statsChunk = {
    type: 'completionStream',
    done: true,
    events: [
      {
        type: 'completionStats',
        seq: 0,
        stats: { timeToFirstToken: 80, tokensPerSecond: 75, cacheTokens: 12, backendDevice: 'cpu' }
      },
      { type: 'completionDone', seq: 1 }
    ]
  }
  const contract = contractValidate('completionStream.response', statsChunk)
  t.ok(contract.valid, `contract accepts stats + done chunk: ${contract.errors}`)

  const badDevice = {
    type: 'completionStream',
    events: [
      { type: 'completionStats', seq: 0, stats: { backendDevice: 'npu' } },
      { type: 'completionDone', seq: 1 }
    ]
  }
  t.is(contractValidate('completionStream.response', badDevice).valid, false)

  const extraKey = {
    type: 'completionStream',
    events: [{ type: 'completionDone', seq: 0 }],
    extraKey: true
  }
  t.is(
    contractValidate('completionStream.response', extraKey).valid,
    false,
    'strict response object rejects unknown keys in the contract too'
  )
})

test('contract transcribeStream.request: validates duplex request shape', (t) => {
  const minimal = { type: 'transcribeStream', modelId: 'test-model' }
  const contract = contractValidate('transcribeStream.request', minimal)
  t.ok(contract.valid, `contract accepts minimal duplex request: ${contract.errors}`)

  const missingModelId = { type: 'transcribeStream' }
  t.is(contractValidate('transcribeStream.request', missingModelId).valid, false)

  // Zod strips unknown keys instead of rejecting; the contract mirrors that
  // by accepting them (audio travels on the duplex stream, not the request).
  const withExtra = {
    type: 'transcribeStream',
    modelId: 'test-model',
    audioChunk: { type: 'filePath', value: '/tmp/audio.wav' }
  }
  t.is(contractValidate('transcribeStream.request', withExtra).valid, true)
})

test('contract transcribeStream.response: validates text, done, and error stream variants', (t) => {
  const variants: Array<[string, Record<string, unknown>]> = [
    ['text segment', { type: 'transcribeStream', text: 'hello world' }],
    ['done marker', { type: 'transcribeStream', done: true }],
    ['in-stream error', { type: 'transcribeStream', error: 'model failed' }]
  ]

  for (const [label, payload] of variants) {
    const contract = contractValidate('transcribeStream.response', payload)
    t.ok(contract.valid, `contract accepts ${label}: ${contract.errors}`)
  }

  const numericText = { type: 'transcribeStream', text: 42 }
  t.is(contractValidate('transcribeStream.response', numericText).valid, false)
})

test('contract error.response: validates the wire error envelope', (t) => {
  const envelope = JSON.parse(
    JSON.stringify(createErrorResponse(new Error('model crashed')))
  ) as Record<string, unknown>

  const contract = contractValidate('error.response', envelope)
  t.ok(contract.valid, `contract accepts createErrorResponse output: ${contract.errors}`)

  t.is(contractValidate('error.response', { type: 'error' }).valid, false, 'message is required')
})

test('contract finetune.request: validates run and control operations', (t) => {
  const runRequest = {
    type: 'finetune',
    modelId: 'm1',
    options: {
      trainDatasetDir: '/tmp/train.jsonl',
      validation: { type: 'none' },
      outputParametersDir: '/tmp/out'
    },
    withProgress: true
  }
  const runContract = contractValidate('finetune.request', runRequest)
  t.ok(runContract.valid, `contract accepts run request: ${runContract.errors}`)

  const pauseRequest = { type: 'finetune', modelId: 'model-pause', operation: 'pause' }
  const pauseContract = contractValidate('finetune.request', pauseRequest)
  t.ok(pauseContract.valid, `contract accepts pause control request: ${pauseContract.errors}`)

  const datasetWithoutPath = {
    type: 'finetune',
    modelId: 'model-invalid',
    operation: 'start',
    options: {
      trainDatasetDir: '/tmp/train.jsonl',
      validation: { type: 'dataset' },
      outputParametersDir: '/tmp/out'
    }
  }
  t.is(
    contractValidate('finetune.request', datasetWithoutPath).valid,
    false,
    'dataset validation without path is rejected by the contract too'
  )
})

test('contract finetune:progress.response: validates progress updates', (t) => {
  const progress = {
    type: 'finetune:progress',
    modelId: 'model-progress',
    is_train: true,
    loss: 1.25,
    loss_uncertainty: null,
    accuracy: 0.75,
    accuracy_uncertainty: null,
    global_steps: 3,
    current_epoch: 1,
    current_batch: 2,
    total_batches: 9,
    elapsed_ms: 1500,
    eta_ms: 2500
  }
  const contract = contractValidate('finetune:progress.response', progress)
  t.ok(contract.valid, `contract accepts nullable progress fields: ${contract.errors}`)

  const badLoss = { type: 'finetune:progress', modelId: 'model-progress', loss: 'high' }
  t.is(contractValidate('finetune:progress.response', badLoss).valid, false)
})

test('contract finetune.response: validates terminal stats payload', (t) => {
  const terminal = {
    type: 'finetune',
    status: 'COMPLETED',
    stats: {
      train_loss: 0.8,
      train_accuracy: 0.9,
      global_steps: 12,
      epochs_completed: 2
    }
  }
  const contract = contractValidate('finetune.response', terminal)
  t.ok(contract.valid, `contract accepts terminal stats payload: ${contract.errors}`)
})
