import test from 'brittle'
import {
  finetuneProgressResponseSchema,
  finetuneRequestSchema,
  finetuneResponseSchema,
  finetuneValidationSchema
} from '@/schemas'

test('finetuneValidationSchema: defaults split validation fraction', (t) => {
  const result = finetuneValidationSchema.parse({
    type: 'split'
  })

  t.is(result.type, 'split')
  t.is(result.type === 'split' ? result.fraction : undefined, 0.05)
})

test('finetuneRequestSchema: accepts an optional requestId on the run shape', (t) => {
  const baseOptions = {
    trainDatasetDir: '/tmp/train.jsonl',
    validation: { type: 'none' as const },
    outputParametersDir: '/tmp/out'
  }
  const result = finetuneRequestSchema.safeParse({
    type: 'finetune',
    modelId: 'm1',
    options: baseOptions,
    requestId: 'req-1'
  })
  t.is(result.success, true)
})

test('finetuneRequestSchema: requestId is optional for run requests', (t) => {
  const baseOptions = {
    trainDatasetDir: '/tmp/train.jsonl',
    validation: { type: 'none' as const },
    outputParametersDir: '/tmp/out'
  }
  const result = finetuneRequestSchema.safeParse({
    type: 'finetune',
    modelId: 'm1',
    options: baseOptions
  })
  t.is(result.success, true)
})

test('finetuneRequestSchema: accepts run, state, and control operations', (t) => {
  const baseOptions = {
    trainDatasetDir: '/tmp/train.jsonl',
    validation: { type: 'none' as const },
    outputParametersDir: '/tmp/out'
  }

  const autoRequest = finetuneRequestSchema.parse({
    type: 'finetune',
    modelId: 'model-auto',
    options: baseOptions,
    withProgress: true
  })
  const startRequest = finetuneRequestSchema.parse({
    type: 'finetune',
    modelId: 'model-start',
    operation: 'start',
    options: baseOptions,
    withProgress: true
  })
  const resumeRequest = finetuneRequestSchema.parse({
    type: 'finetune',
    modelId: 'model-resume',
    operation: 'resume',
    options: baseOptions
  })
  const getStateRequest = finetuneRequestSchema.parse({
    type: 'finetune',
    modelId: 'model-state',
    operation: 'getState',
    options: baseOptions
  })
  const pauseRequest = finetuneRequestSchema.parse({
    type: 'finetune',
    modelId: 'model-pause',
    operation: 'pause'
  })
  const cancelRequest = finetuneRequestSchema.parse({
    type: 'finetune',
    modelId: 'model-cancel',
    operation: 'cancel'
  })

  t.is(autoRequest.operation, undefined)
  t.is(startRequest.operation, 'start')
  t.is(resumeRequest.operation, 'resume')
  t.is(getStateRequest.operation, 'getState')
  t.is(pauseRequest.operation, 'pause')
  t.is(cancelRequest.operation, 'cancel')
})

test('finetuneRequestSchema: rejects dataset validation without path', (t) => {
  t.exception(() =>
    finetuneRequestSchema.parse({
      type: 'finetune',
      modelId: 'model-invalid',
      operation: 'start',
      options: {
        trainDatasetDir: '/tmp/train.jsonl',
        validation: { type: 'dataset' },
        outputParametersDir: '/tmp/out'
      }
    })
  )
})

test('finetuneProgressResponseSchema: parses nullable progress fields', (t) => {
  const progress = finetuneProgressResponseSchema.parse({
    type: 'finetune:progress',
    modelId: 'model-progress',
    isTrain: true,
    loss: 1.25,
    lossUncertainty: null,
    accuracy: 0.75,
    accuracyUncertainty: null,
    globalSteps: 3,
    currentEpoch: 1,
    currentBatch: 2,
    totalBatches: 9,
    elapsedMs: 1500,
    etaMs: 2500
  })

  t.is(progress.type, 'finetune:progress')
  t.is(progress.modelId, 'model-progress')
  t.is(progress.loss, 1.25)
  t.is(progress.lossUncertainty, null)
  t.is(progress.accuracy, 0.75)
  t.is(progress.globalSteps, 3)
})

test('finetuneResponseSchema: parses terminal stats payload', (t) => {
  const response = finetuneResponseSchema.parse({
    type: 'finetune',
    status: 'COMPLETED',
    stats: {
      trainLoss: 0.8,
      trainAccuracy: 0.9,
      globalSteps: 12,
      epochsCompleted: 2
    }
  })

  t.is(response.type, 'finetune')
  t.is(response.status, 'COMPLETED')
  t.is(response.stats?.globalSteps, 12)
  t.is(response.stats?.epochsCompleted, 2)
})

test('finetuneResponseSchema: parses idle terminal status', (t) => {
  const response = finetuneResponseSchema.parse({
    type: 'finetune',
    status: 'IDLE'
  })

  t.is(response.type, 'finetune')
  t.is(response.status, 'IDLE')
})

test('finetuneResponseSchema: parses running status', (t) => {
  const response = finetuneResponseSchema.parse({
    type: 'finetune',
    status: 'RUNNING'
  })

  t.is(response.type, 'finetune')
  t.is(response.status, 'RUNNING')
})

test('finetuneResponseSchema: parses cancelled terminal status', (t) => {
  const response = finetuneResponseSchema.parse({
    type: 'finetune',
    status: 'CANCELLED'
  })

  t.is(response.type, 'finetune')
  t.is(response.status, 'CANCELLED')
})

test('finetuneResponseSchema: accepts NaN terminal uncertainties', (t) => {
  const response = finetuneResponseSchema.parse({
    type: 'finetune',
    status: 'COMPLETED',
    stats: {
      trainLoss: 0.8,
      trainLossUncertainty: Number.NaN,
      valLoss: 0.7,
      valLossUncertainty: Number.NaN,
      trainAccuracy: 0.9,
      trainAccuracyUncertainty: Number.NaN,
      valAccuracy: 0.85,
      valAccuracyUncertainty: Number.NaN,
      globalSteps: 3,
      epochsCompleted: 1
    }
  })

  t.ok(Number.isNaN(response.stats?.trainLossUncertainty))
  t.ok(Number.isNaN(response.stats?.valLossUncertainty))
  t.ok(Number.isNaN(response.stats?.trainAccuracyUncertainty))
  t.ok(Number.isNaN(response.stats?.valAccuracyUncertainty))
})

test('finetuneResponseSchema: accepts null terminal uncertainties', (t) => {
  const response = finetuneResponseSchema.parse({
    type: 'finetune',
    status: 'COMPLETED',
    stats: {
      trainLoss: 0.8,
      trainLossUncertainty: null,
      valLoss: 0.7,
      valLossUncertainty: null,
      trainAccuracy: 0.9,
      trainAccuracyUncertainty: null,
      valAccuracy: 0.85,
      valAccuracyUncertainty: null,
      globalSteps: 3,
      epochsCompleted: 1
    }
  })

  t.is(response.stats?.trainLossUncertainty, null)
  t.is(response.stats?.valLossUncertainty, null)
  t.is(response.stats?.trainAccuracyUncertainty, null)
  t.is(response.stats?.valAccuracyUncertainty, null)
})
