import test from 'brittle'
import crypto from 'bare-crypto'
import fs from 'bare-fs'
import os from 'bare-os'
import path from 'bare-path'
import type { FitLlamaResult } from '@qvac/model-fit/process'

import type { Logger } from '@/logging/types'
import { ModelType } from '@/schemas/index'
import type { IsolatedFitResult } from '@/resources/model-fit/native-probe/run-isolated-fit'
import { projectFitFromStub } from '@/resources/model-fit/fit-stub/project-fit-from-stub'
import type { FitBlobBinding, FitStubRef } from '@/resources/model-fit/fit-stub/fetch-fit-stub'

const REF: FitStubRef = {
  name: 'Llama-3.2-1B-Instruct-Q4_0',
  sha256Checksum: 'a'.repeat(64),
  registryPath: 'models/llama-3.2-1b',
  registrySource: 'huggingface'
}

const STUB_BYTES = Buffer.from('GGUF' + 'x'.repeat(28))
const BINDING: FitBlobBinding = {
  coreKey: 'c'.repeat(64),
  blockOffset: 0,
  blockLength: 1,
  byteOffset: 0,
  byteLength: STUB_BYTES.length,
  sha256: crypto.createHash('sha-256').update(STUB_BYTES).digest('hex')
}

const FIT_PLAN: FitLlamaResult = {
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

const MODEL_CONFIG = { ctx_size: 4096, gpu_layers: 99, device: 'gpu' }

function silentLogger(): Logger {
  const noop = () => {}
  return {
    error: noop,
    warn: noop,
    info: noop,
    debug: noop,
    trace: noop,
    setLevel: noop,
    getLevel: () => 2,
    addTransport: noop,
    setConsoleOutput: noop
  } as unknown as Logger
}

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'fit-stub-project-'))
}

function stubOptions(cacheDir: string) {
  return {
    cacheDir,
    logger: silentLogger(),
    getEntry: async () => ({ fitBlobBinding: BINDING }),
    downloadBlob: async (_binding: FitBlobBinding, outputFile: string) => {
      fs.writeFileSync(outputFile, STUB_BYTES)
    }
  }
}

test('a projection runs the fitter against the downloaded stub', async function (t) {
  const cacheDir = tempDir()
  const seen: string[] = []

  const res = await projectFitFromStub(
    { model: REF, modelType: ModelType.llamacppCompletion, modelConfig: MODEL_CONFIG },
    {
      stub: stubOptions(cacheDir),
      fit: {
        enabled: true,
        mobile: false,
        logger: silentLogger(),
        residentModelBytes: () => Promise.resolve(0),
        runFit: async (_kind, config): Promise<IsolatedFitResult> => {
          seen.push(config.modelPath)
          return { status: 'completed', result: FIT_PLAN }
        }
      }
    }
  )

  t.is(res.status, 'projected')
  if (res.status !== 'projected') return

  t.is(seen.length, 1, 'the fitter ran once')
  t.is(
    path.basename(seen[0] ?? ''),
    `${BINDING.sha256}.gguf`,
    'pointed at the stub, not at any artifact'
  )
  t.is(res.fit.verdict, 'fit')
  t.absent(fs.existsSync(seen[0] ?? ''), 'the stub is removed once the fitter has read it')
  t.alike(fs.readdirSync(cacheDir), [], 'nothing is left under the staging root')
})

// No stub is a normal outcome — an older record, or an offline caller — and it
// must not reach the fitter with a path that does not exist.
test('a model with no fit blob does not reach the fitter', async function (t) {
  let fitCalls = 0

  const res = await projectFitFromStub(
    { model: REF, modelType: ModelType.llamacppCompletion, modelConfig: MODEL_CONFIG },
    {
      stub: { cacheDir: tempDir(), logger: silentLogger(), getEntry: async () => ({}) },
      fit: {
        enabled: true,
        mobile: false,
        logger: silentLogger(),
        residentModelBytes: () => Promise.resolve(0),
        runFit: async (): Promise<IsolatedFitResult> => {
          fitCalls++
          return { status: 'completed', result: FIT_PLAN }
        }
      }
    }
  )

  t.is(res.status, 'no-stub')
  if (res.status === 'no-stub') t.is(res.reason, 'no-fit-blob')
  t.is(fitCalls, 0, 'the fitter was not run')
})
