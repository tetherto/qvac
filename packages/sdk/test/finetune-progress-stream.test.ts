import { mock, test } from 'node:test'
import assert from 'node:assert/strict'

const tick = {
  isTrain: true,
  loss: 1.5,
  lossUncertainty: null,
  accuracy: 0.25,
  accuracyUncertainty: null,
  globalSteps: 3,
  currentEpoch: 1,
  currentBatch: 2,
  totalBatches: 8,
  elapsedMs: 900,
  etaMs: 2700
}

const legacyTick = {
  is_train: true,
  loss_uncertainty: null,
  accuracy_uncertainty: null,
  global_steps: 3,
  current_epoch: 1,
  current_batch: 2,
  total_batches: 8,
  elapsed_ms: 900,
  eta_ms: 2700
}

mock.module('@/client/rpc/rpc-client', {
  namedExports: {
    stream: async function* () {
      yield { type: 'finetune:progress', modelId: 'llm', ...tick, ...legacyTick }
      yield { type: 'finetune', status: 'COMPLETED' }
    },
    send: async () => {
      throw new Error('unused')
    }
  }
})

const { finetune } = await import('@/client/api/finetune')

test('finetune progressStream keeps the deprecated progress fields next to the new ones', async () => {
  const handle = finetune({
    modelId: 'llm',
    options: {
      trainDatasetDir: './dataset/train',
      validation: { type: 'split', fraction: 0.05 },
      outputParametersDir: './artifacts/lora'
    }
  })
  const ticks = []
  for await (const progress of handle.progressStream) ticks.push(progress)
  assert.deepEqual(ticks, [{ ...tick, ...legacyTick }])
  assert.equal((await handle.result).status, 'COMPLETED')
})
