import test from 'brittle'
import env from 'bare-env'
import os from 'bare-os'
import path from 'bare-path'
import { z } from 'zod'
import { send, close } from '@/dispatch'
import { registry } from '@/registry'
import { clearPlugins, registerPlugin } from '@/plugins'
import * as builtin from '@/plugins/builtin/index'
import { registerModel, unregisterModel, type AnyModel } from '@/runtime/model-registry'
import { PluginDefinitionInvalidError } from '@/errors'
import { CAPABILITY_CONTRACTS, type CapabilityDeclaration, type Request } from '@/schemas'
import { definePlugin, type PluginHandlerDefinition, type QvacPlugin } from '@/schemas/plugin'
import {
  QVAC_OPERATION_CALL_SHAPES,
  handlerCallShape,
  resolveCapabilityDeclaration,
  type OperationCallShape
} from '@/plugins/capabilities'

// A plugin that declares a contract must be callable the way a consumer of
// that contract calls it. These tests hold registration, the call-shape table
// and the runtime's dispatch to the same answer.

env['HOME'] = path.join(os.tmpdir(), `qvac-inference-conformance-test-${os.pid()}`)

const BUILTIN_PLUGINS: QvacPlugin[] = Object.values(builtin) as QvacPlugin[]

const QVAC_OPERATIONS = Object.values(CAPABILITY_CONTRACTS).flatMap((contract) => [
  ...contract.operations,
  ...contract.optionalOperations
])

function handler(
  shape: OperationCallShape,
  run: () => unknown = () => ({ ok: true })
): PluginHandlerDefinition {
  const streaming = shape !== 'reply'
  return {
    requestSchema: z.looseObject({}),
    responseSchema: z.looseObject({}),
    streaming,
    ...(shape === 'duplex' && { duplex: true }),
    handler: streaming
      ? async function* () {
          yield run()
        }
      : async function () {
          return run()
        }
  } as PluginHandlerDefinition
}

function plugin(
  modelType: string,
  handlers: Record<string, PluginHandlerDefinition>,
  provides?: readonly CapabilityDeclaration[]
): QvacPlugin {
  return definePlugin({
    modelType,
    displayName: modelType,
    addonPackage: `@acme/${modelType}`,
    loadConfigSchema: z.looseObject({}),
    skipPrimaryModelPathValidation: true,
    createModel: () => ({ model: { load: async () => {}, unload: async () => {} } }),
    handlers,
    ...(provides && { provides })
  })
}

function registerFakeModel(modelId: string, modelType: string) {
  registerModel(modelId, {
    model: { load: async () => {}, unload: async () => {} } as unknown as AnyModel,
    path: '/tmp/model.bin',
    config: {},
    modelType: modelType as never
  })
}

function rejectionReason(candidate: QvacPlugin): string | undefined {
  try {
    registerPlugin(candidate)
  } catch (error) {
    if (error instanceof PluginDefinitionInvalidError) return error.message
    throw error
  }
  return undefined
}

test('the call-shape table covers every QVAC operation and agrees with the request registry', function (t) {
  t.alike(
    Object.keys(QVAC_OPERATION_CALL_SHAPES).sort(),
    [...QVAC_OPERATIONS].sort(),
    'one shape per QVAC contract operation'
  )
  for (const operation of QVAC_OPERATIONS) {
    const shape = QVAC_OPERATION_CALL_SHAPES[operation]
    const entry = registry[operation]
    if (entry) {
      t.is(shape, entry.type, `${operation} is called as a ${entry.type}`)
    } else {
      t.not(
        shape,
        'duplex',
        `${operation} is reached through pluginInvoke, which has no duplex form`
      )
    }
  }
})

test('every built-in plugin serves its declared operations with the shape the runtime calls', function (t) {
  for (const builtinPlugin of BUILTIN_PLUGINS) {
    for (const declaration of builtinPlugin.provides ?? []) {
      const contract = resolveCapabilityDeclaration(declaration)
      if (typeof contract === 'string') {
        t.fail(`${builtinPlugin.modelType}: ${contract}`)
        continue
      }
      for (const operation of [...contract.operations, ...contract.optionalOperations]) {
        const definition = builtinPlugin.handlers[operation]
        if (!definition) continue
        t.is(
          handlerCallShape(definition),
          QVAC_OPERATION_CALL_SHAPES[operation],
          `${builtinPlugin.modelType}.${operation}`
        )
      }
    }
  }
})

test('registerPlugin rejects a QVAC operation served with another shape', function (t) {
  clearPlugins()
  try {
    t.ok(
      /"transcribe" of capability "transcription@1" is a reply handler, but the runtime calls transcribe as a stream/.test(
        rejectionReason(
          plugin('reply-asr', { transcribe: handler('reply') }, [
            CAPABILITY_CONTRACTS.transcription
          ])
        ) ?? ''
      ),
      'a required operation'
    )
    t.ok(
      /"transcribeStream" of capability "transcription@1" is a stream handler, but the runtime calls transcribeStream as a duplex/.test(
        rejectionReason(
          plugin(
            'stream-asr',
            { transcribe: handler('stream'), transcribeStream: handler('stream') },
            [CAPABILITY_CONTRACTS.transcription]
          )
        ) ?? ''
      ),
      'an optional operation'
    )
  } finally {
    clearPlugins()
  }
})

test('registerPlugin rejects a third-party provider that serves a shared operation with another shape', function (t) {
  clearPlugins()
  try {
    const contract = { id: 'acme.diarization', version: 1, operations: ['diarize'] }
    registerPlugin(plugin('first', { diarize: handler('stream') }, [contract]))
    t.ok(
      /"diarize" of capability "acme.diarization@1" is a reply handler, but plugin "first" serves it as a stream handler/.test(
        rejectionReason(plugin('second', { diarize: handler('reply') }, [contract])) ?? ''
      )
    )
    t.absent(
      rejectionReason(plugin('third', { diarize: handler('stream') }, [contract])),
      'a provider with the same shape registers'
    )
  } finally {
    clearPlugins()
  }
})

test('a third-party shape conflict on an optional operation is rejected in either registration order', function (t) {
  const newer = () =>
    plugin('newer', { run: handler('reply'), extra: handler('stream') }, [
      { id: 'acme.x', version: 1, operations: ['run'], optionalOperations: ['extra'] }
    ])
  const older = () =>
    plugin('older', { run: handler('reply'), extra: handler('reply') }, [
      { id: 'acme.x', version: 1, operations: ['run'] }
    ])
  for (const [first, second] of [
    [newer, older],
    [older, newer]
  ]) {
    clearPlugins()
    try {
      registerPlugin(first())
      t.ok(
        /handler "extra" of capability "acme.x@1"/.test(rejectionReason(second()) ?? ''),
        `${second().modelType} after ${first().modelType} is rejected`
      )
    } finally {
      clearPlugins()
    }
  }
})

const EMBEDDING = { type: 'embed', success: true, embedding: [0.25, 0.5] }

for (const provides of [[CAPABILITY_CONTRACTS.embedding], undefined]) {
  const label = provides ? 'that declares embedding@1' : 'without provides'
  test(`a plugin ${label} serves the typed embed request through the runtime`, async function (t) {
    clearPlugins()
    const modelType = provides ? 'acme-embedder' : 'legacy-embedder'
    const modelId = `${modelType}-model`
    try {
      registerPlugin(
        plugin(
          modelType,
          { embed: handler('reply', () => EMBEDDING), embedBatch: handler('reply') },
          provides
        )
      )
      registerFakeModel(modelId, modelType)
      const response = await send({ type: 'embed', modelId, text: 'hello' } as Request)
      t.alike(response, EMBEDDING)
    } finally {
      unregisterModel(modelId)
      await close()
      clearPlugins()
    }
  })
}
