import test from 'brittle'
import env from 'bare-env'
import fs from 'bare-fs'
import os from 'bare-os'
import path from 'bare-path'
import { AbortController } from 'bare-abort-controller'
import { z } from 'zod'

import { InferenceCancelledError } from '@/errors/index'
import { loadModel } from '@/plugins/ops/load-model'
import { registerPlugin, unregisterPlugin } from '@/plugins/registry'
import { isModelLoaded } from '@/runtime/model-registry'
import { ModelType } from '@/schemas/index'
import type { QvacPlugin } from '@/schemas/plugin'

env['HOME'] = path.join(os.tmpdir(), `qvac-load-model-fit-cancel-${os.pid()}`)

test('loadModel: a cancel during the fit check stops the load before the addon runs', async (t) => {
  const controller = new AbortController()
  let created = 0
  let fitted = 0
  const plugin = {
    modelType: ModelType.llamacppCompletion,
    displayName: 'Cancelled fit',
    addonPackage: '@qvac/llm-llamacpp',
    loadConfigSchema: z.looseObject({}),
    createModel: () => {
      created += 1
      return { model: { load: async () => {}, unload: async () => {} } }
    },
    assessFit: () => {
      fitted += 1
      controller.abort(undefined)
      return new Promise(() => {})
    },
    handlers: {}
  } as unknown as QvacPlugin
  registerPlugin(plugin)
  t.teardown(() => unregisterPlugin(plugin.modelType))

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qvac-load-model-fit-cancel-'))
  const modelPath = path.join(dir, 'model.gguf')
  fs.writeFileSync(modelPath, '')

  let thrown: unknown
  try {
    await loadModel(
      {
        modelId: 'fit-cancel',
        modelPath,
        options: {
          type: 'loadModel',
          modelSrc: modelPath,
          modelType: ModelType.llamacppCompletion,
          modelConfig: {},
          modelFitPolicy: 'log'
        }
      } as never,
      { request: { signal: controller.signal, requestId: 'req-fit-cancel' } }
    )
  } catch (error) {
    thrown = error
  }

  t.is(fitted, 1, 'the fit check ran')
  t.ok(thrown instanceof InferenceCancelledError, 'the load is cancelled')
  t.is(created, 0, 'the addon never loads')
  t.absent(isModelLoaded('fit-cancel'))
})
