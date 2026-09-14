import test from 'brittle'
import fs from 'bare-fs'
import os from 'bare-os'
import path from 'bare-path'
import type { FitConfig, FitResult } from '@qvac/model-fit'

import { ModelType } from '@/schemas/index'
import { createLlamaFitRequest } from '@/resources/model-fit/native-probe/create-llama-fit-request'
import {
  crashMarkerPath,
  crashedMarkerPath,
  runInProcessFit,
  toFitConfig
} from '@/resources/model-fit/native-probe/run-in-process-fit'

const CONFIG = {
  modelPath: '/models/model.gguf',
  params: { device: 'gpu', ctx_size: '4096', gpu_layers: '99' },
  nCtxMin: 4096,
  marginMiB: 1024
}

const FIT_PLAN: FitResult = {
  status: 0,
  fits: true,
  reason: 'fits',
  maxDevices: 1,
  nDevices: 1,
  nGpuDevices: 1,
  nGpuLayers: 32,
  nCtx: 4096,
  nBatch: 512,
  nUbatch: 512,
  tensorSplit: [1],
  buftOverrides: [],
  splitMode: 1,
  mainGpu: 0,
  typeK: 1,
  typeV: 1,
  flashAttnType: 1
}

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'qvac-in-process-fit-'))
}

test('toFitConfig: forwards path, context, offload, and margin', (t) => {
  t.alike(toFitConfig(CONFIG), {
    modelPath: '/models/model.gguf',
    marginMiB: 1024,
    nCtxMin: 4096,
    nCtx: 4096,
    nGpuLayers: 99
  })
})

test('toFitConfig: omits auto context so the fitter can choose', (t) => {
  const config = toFitConfig({
    modelPath: '/models/model.gguf',
    params: { ctx_size: '0' }
  })
  t.absent('nCtx' in config)
})

test('toFitConfig: maps KV, flash, split, and main-gpu onto FitConfig', (t) => {
  t.alike(
    toFitConfig({
      modelPath: '/models/model.gguf',
      params: {
        device: 'gpu',
        ctx_size: '4096',
        gpu_layers: '99',
        'cache-type-k': 'q8_0',
        'cache-type-v': 'q8_0',
        'flash-attn': 'on',
        'split-mode': 'layer',
        'main-gpu': '0'
      }
    }),
    {
      modelPath: '/models/model.gguf',
      nCtx: 4096,
      nGpuLayers: 99,
      typeK: 8,
      typeV: 8,
      flashAttnType: 1,
      splitMode: 1,
      mainGpu: 0
    }
  )
})

test('toFitConfig: maps embedding flash_attn, batch, and split', (t) => {
  t.alike(
    toFitConfig({
      modelPath: '/models/model.gguf',
      params: {
        gpu_layers: '99',
        batch_size: '1024',
        flash_attn: 'auto',
        'split-mode': 'none'
      }
    }),
    {
      modelPath: '/models/model.gguf',
      nGpuLayers: 99,
      nBatch: 1024,
      flashAttnType: -1,
      splitMode: 0
    }
  )
})

test('toFitConfig: converts the params createLlamaFitRequest actually forwards', (t) => {
  const completion = createLlamaFitRequest({
    modelType: ModelType.llamacppCompletion,
    modelPath: '/models/model.gguf',
    modelConfig: {
      ctx_size: 4096,
      gpu_layers: 99,
      device: 'gpu',
      'cache-type-k': 'q8_0',
      'cache-type-v': 'q8_0',
      'flash-attn': 'on',
      'main-gpu': 0,
      'split-mode': 'layer'
    },
    isShardedModel: false
  })
  t.ok(completion.supported)
  if (!completion.supported) return
  t.alike(toFitConfig(completion.config), {
    modelPath: '/models/model.gguf',
    nCtxMin: 4096,
    nCtx: 4096,
    nGpuLayers: 99,
    typeK: 8,
    typeV: 8,
    flashAttnType: 1,
    splitMode: 1,
    mainGpu: 0
  })
  t.absent('nUbatch' in toFitConfig(completion.config))
  t.absent('swaFull' in toFitConfig(completion.config))

  const embedding = createLlamaFitRequest({
    modelType: ModelType.llamacppEmbedding,
    modelPath: '/models/embed.gguf',
    modelConfig: {
      device: 'gpu',
      gpuLayers: 99,
      batchSize: 1024,
      flashAttention: 'auto'
    },
    isShardedModel: false
  })
  t.ok(embedding.supported)
  if (!embedding.supported) return
  t.alike(toFitConfig(embedding.config), {
    modelPath: '/models/embed.gguf',
    nGpuLayers: 99,
    nBatch: 1024,
    flashAttnType: -1
  })
})

test('toFitConfig: flash-attn true is not treated as on', (t) => {
  try {
    toFitConfig({
      modelPath: '/models/model.gguf',
      params: { 'flash-attn': 'true' }
    })
    t.fail('expected flash-attn true to fail conversion')
  } catch (error) {
    t.ok(error instanceof TypeError)
    t.ok(/Unsupported flash-attn/.test(String(error)))
  }
})

test('toFitConfig: unmapped KV cache type fails instead of omitting', (t) => {
  try {
    toFitConfig({
      modelPath: '/models/model.gguf',
      params: { 'cache-type-k': 'tbq4_0' }
    })
    t.fail('expected unmapped KV cache type to fail conversion')
  } catch (error) {
    t.ok(error instanceof TypeError)
    t.ok(/Unsupported KV cache type/.test(String(error)))
  }
})

test('runInProcessFit: returns the native projection', async (t) => {
  const stateDir = tempDir()
  const calls: FitConfig[] = []

  const result = await runInProcessFit('completion', CONFIG, {
    stateDir,
    fit: (config) => {
      calls.push(config)
      return FIT_PLAN
    }
  })

  t.alike(result, { status: 'completed', result: FIT_PLAN })
  t.alike(calls, [toFitConfig(CONFIG)])
  t.is(exists(crashMarkerPath(stateDir, CONFIG)), false)
  t.is(exists(crashedMarkerPath(stateDir, CONFIG)), false)
})

test('runInProcessFit: leftover crash marker is unknown and skips the native call', async (t) => {
  const stateDir = tempDir()
  fs.writeFileSync(crashMarkerPath(stateDir, CONFIG), '')
  let called = 0

  const result = await runInProcessFit('completion', CONFIG, {
    stateDir,
    fit: () => {
      called += 1
      return FIT_PLAN
    }
  })

  t.is(called, 0)
  t.is(result.status, 'unknown')
  if (result.status !== 'unknown') return
  t.is(result.reason, 'crashed')
  t.is(exists(crashMarkerPath(stateDir, CONFIG)), false)
  t.is(exists(crashedMarkerPath(stateDir, CONFIG)), true)
})

test('runInProcessFit: leftover crashed marker keeps skipping native', async (t) => {
  const stateDir = tempDir()
  fs.mkdirSync(stateDir, { recursive: true })
  fs.writeFileSync(crashedMarkerPath(stateDir, CONFIG), '')
  let called = 0

  const result = await runInProcessFit('completion', CONFIG, {
    stateDir,
    fit: () => {
      called += 1
      return FIT_PLAN
    }
  })

  t.is(called, 0)
  t.is(result.status, 'unknown')
  if (result.status !== 'unknown') return
  t.is(result.reason, 'crashed')
  t.is(exists(crashedMarkerPath(stateDir, CONFIG)), true)
})

test('runInProcessFit: a thrown fit still clears the crash marker', async (t) => {
  const stateDir = tempDir()

  const result = await runInProcessFit('completion', CONFIG, {
    stateDir,
    fit: () => {
      throw new TypeError('native exploded')
    }
  })

  t.alike(result, {
    status: 'unknown',
    reason: 'invocation-error',
    message: 'TypeError: native exploded'
  })
  t.is(exists(crashMarkerPath(stateDir, CONFIG)), false)
  t.is(exists(crashedMarkerPath(stateDir, CONFIG)), false)
})

test('runInProcessFit: unmapped params are invocation-error and skip native', async (t) => {
  const stateDir = tempDir()
  let called = 0
  const config = {
    modelPath: '/models/model.gguf',
    params: { 'cache-type-k': 'tbq4_0' }
  }

  const result = await runInProcessFit('completion', config, {
    stateDir,
    fit: () => {
      called += 1
      return FIT_PLAN
    }
  })

  t.is(called, 0)
  t.is(result.status, 'unknown')
  if (result.status !== 'unknown') return
  t.is(result.reason, 'invocation-error')
})

function exists(file: string) {
  try {
    fs.accessSync(file)
    return true
  } catch {
    return false
  }
}
