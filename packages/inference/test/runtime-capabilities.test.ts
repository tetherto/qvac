import test from 'brittle'
import env from 'bare-env'
import os from 'bare-os'
import path from 'bare-path'
import { z } from 'zod'
import { send, close } from '@/dispatch'
import { getRuntimeCapabilities } from '@/api/get-runtime-capabilities'
import { clearPlugins, getProvidedCapabilities, registerPlugin, registerPlugins } from '@/plugins'
import * as builtin from '@/plugins/builtin/index'
import { clearSessions, openSession } from '@/runtime/session-registry'
import { PluginDefinitionInvalidError, SessionNotOpenError as SessionNotOpen } from '@/errors'
import {
  CAPABILITY_CONTRACTS,
  type CapabilityDeclaration,
  type Request,
  type Response
} from '@/schemas'
import { definePlugin, type PluginHandlerDefinition, type QvacPlugin } from '@/schemas/plugin'
import {
  QVAC_OPERATION_CALL_SHAPES,
  resolveCapabilityDeclaration,
  type OperationCallShape
} from '@/plugins/capabilities'

env['HOME'] = path.join(os.tmpdir(), `qvac-inference-capabilities-test-${os.pid()}`)

const SessionNotOpenError = SessionNotOpen as unknown as new () => Error

const BUILTIN_PLUGINS: QvacPlugin[] = Object.values(builtin) as QvacPlugin[]

let createModelCalls = 0

function makeHandler(shape: OperationCallShape): PluginHandlerDefinition {
  return {
    requestSchema: z.object({}),
    responseSchema: z.object({ ok: z.boolean() }),
    streaming: shape !== 'reply',
    ...(shape === 'duplex' && { duplex: true }),
    handler: async function () {
      return { ok: true }
    }
  } as PluginHandlerDefinition
}

// A handler takes the shape the runtime calls a QVAC operation with, unless
// the test names another.
function makePlugin(
  modelType: string,
  handlerNames: string[],
  provides?: readonly CapabilityDeclaration[],
  shapes: Record<string, OperationCallShape> = {}
): QvacPlugin {
  const handlers = Object.fromEntries(
    handlerNames.map((name) => [
      name,
      makeHandler(shapes[name] ?? QVAC_OPERATION_CALL_SHAPES[name] ?? 'reply')
    ])
  )
  return definePlugin({
    modelType,
    displayName: `Display ${modelType}`,
    addonPackage: `@acme/addon-${modelType}`,
    loadConfigSchema: z.object({}),
    createModel() {
      createModelCalls++
      return { model: { load: async function () {} } }
    },
    handlers,
    ...(provides && { provides })
  })
}

function thirdParty(
  id: string,
  version: number,
  operations: string[],
  optionalOperations: string[] = []
): CapabilityDeclaration {
  return { id, version, operations, optionalOperations }
}

interface Assert {
  ok(value: unknown, message?: string): void
}

function assertRejected(t: Assert, plugin: QvacPlugin, why: RegExp) {
  let error: unknown
  try {
    registerPlugin(plugin)
  } catch (caught) {
    error = caught
  }
  t.ok(error instanceof PluginDefinitionInvalidError, `${plugin.modelType} is rejected`)
  t.ok(why.test((error as Error | undefined)?.message ?? ''), `the reason matches ${why}`)
}

test('every built-in handler belongs to exactly one capability contract', function (t) {
  for (const plugin of BUILTIN_PLUGINS) {
    for (const handlerName of Object.keys(plugin.handlers)) {
      const owners = (plugin.provides ?? [])
        .map(resolveCapabilityDeclaration)
        .filter(
          (contract) =>
            typeof contract !== 'string' &&
            [...contract.operations, ...contract.optionalOperations].includes(handlerName)
        )
      t.is(owners.length, 1, `${plugin.modelType}.${handlerName} is in one contract`)
    }
  }
})

test('the default plugin set reports every QVAC contract at major 1', function (t) {
  clearPlugins()
  try {
    registerPlugins(BUILTIN_PLUGINS)
    t.alike(getProvidedCapabilities(), [
      {
        id: 'audio-generation',
        version: 1,
        operations: ['audioEditStream', 'audioGenStream'],
        partialOperations: []
      },
      {
        id: 'audio-understanding',
        version: 1,
        operations: ['audioUnderstand'],
        partialOperations: []
      },
      {
        id: 'bci-transcription',
        version: 1,
        operations: ['bciTranscribe', 'bciTranscribeStream'],
        partialOperations: []
      },
      { id: 'classification', version: 1, operations: ['classify'], partialOperations: [] },
      {
        id: 'completion',
        version: 1,
        operations: ['batchCompletionStream', 'calcTokens', 'completionStream'],
        partialOperations: []
      },
      { id: 'decision', version: 1, operations: ['decide'], partialOperations: [] },
      { id: 'embedding', version: 1, operations: ['embed', 'embedBatch'], partialOperations: [] },
      { id: 'fine-tuning', version: 1, operations: ['finetune'], partialOperations: [] },
      {
        id: 'image-generation',
        version: 1,
        operations: ['diffusionStream'],
        partialOperations: []
      },
      { id: 'image-upscaling', version: 1, operations: ['upscaleStream'], partialOperations: [] },
      { id: 'ocr', version: 1, operations: ['ocrStream'], partialOperations: [] },
      { id: 'reranking', version: 1, operations: ['rerank'], partialOperations: [] },
      {
        id: 'stereo-depth-estimation',
        version: 1,
        operations: ['estimateDisparity'],
        partialOperations: []
      },
      {
        id: 'text-to-speech',
        version: 1,
        operations: ['textToSpeech', 'textToSpeechStream'],
        partialOperations: []
      },
      {
        id: 'transcription',
        version: 1,
        operations: ['transcribe'],
        partialOperations: ['transcribeStream']
      },
      { id: 'translation', version: 1, operations: ['translate'], partialOperations: [] },
      { id: 'video-generation', version: 1, operations: ['videoStream'], partialOperations: [] },
      {
        id: 'vision-language-action',
        version: 1,
        operations: ['vlaHparams', 'vlaRun', 'vlaSetEmbodiment'],
        partialOperations: []
      },
      {
        id: 'world-simulation',
        version: 1,
        operations: ['worldSceneStream', 'worldStepStream'],
        partialOperations: []
      }
    ])
  } finally {
    clearPlugins()
  }
})

test('an optional operation is partial only while some provider lacks it', function (t) {
  clearPlugins()
  try {
    registerPlugin(builtin.whisperPlugin)
    t.alike(
      getProvidedCapabilities(),
      [
        {
          id: 'transcription',
          version: 1,
          operations: ['transcribe', 'transcribeStream'],
          partialOperations: []
        }
      ],
      'whisper alone streams'
    )

    registerPlugin(builtin.mossTranscribePlugin)
    t.alike(
      getProvidedCapabilities(),
      [
        {
          id: 'transcription',
          version: 1,
          operations: ['transcribe'],
          partialOperations: ['transcribeStream']
        }
      ],
      'MOSS has no transcribeStream, so streaming becomes partial'
    )
  } finally {
    clearPlugins()
  }
})

test('a contract provided by several plugins is reported once, and each major separately', function (t) {
  clearPlugins()
  try {
    registerPlugin(makePlugin('nmt-a', ['translate'], [CAPABILITY_CONTRACTS.translation]))
    registerPlugin(makePlugin('nmt-b', ['translate'], [CAPABILITY_CONTRACTS.translation]))
    registerPlugin(
      makePlugin(
        'diarizer',
        ['diarize'],
        [
          thirdParty('acme.diarization', 2, ['diarize']),
          thirdParty('acme.diarization', 1, ['diarize'])
        ]
      )
    )
    t.alike(getProvidedCapabilities(), [
      { id: 'acme.diarization', version: 1, operations: ['diarize'], partialOperations: [] },
      { id: 'acme.diarization', version: 2, operations: ['diarize'], partialOperations: [] },
      { id: 'translation', version: 1, operations: ['translate'], partialOperations: [] }
    ])
  } finally {
    clearPlugins()
  }
})

test('a plugin without provides adds nothing, and an empty registry reports an empty list', async function (t) {
  clearPlugins()
  try {
    t.alike(getProvidedCapabilities(), [], 'empty registry')
    t.alike(await getRuntimeCapabilities(), [], 'the request runs before any plugin is registered')

    registerPlugin(makePlugin('legacy', ['ping']))
    t.alike(await getRuntimeCapabilities(), [], 'a plugin without provides is invisible')
  } finally {
    await close()
    clearPlugins()
  }
})

test('the report names no implementation and loads no model', async function (t) {
  clearPlugins()
  createModelCalls = 0
  try {
    registerPlugin(makePlugin('secret-engine', ['decide'], [CAPABILITY_CONTRACTS.decision]))
    const response = await send({ type: 'getRuntimeCapabilities' } as Request)
    const wire = JSON.stringify(response)
    t.absent(wire.includes('secret-engine'), 'no modelType')
    t.absent(wire.includes('Display secret-engine'), 'no displayName')
    t.absent(wire.includes('@acme/addon'), 'no addonPackage')
    t.is(createModelCalls, 0, 'no model was created')
  } finally {
    await close()
    clearPlugins()
  }
})

test('getRuntimeCapabilities runs as an open session and refuses an unknown one', async function (t) {
  clearPlugins()
  clearSessions()
  openSession('s-capabilities')
  try {
    registerPlugin(makePlugin('ocr-engine', ['ocrStream'], [CAPABILITY_CONTRACTS.ocr]))
    const response = (await send({
      type: 'getRuntimeCapabilities',
      sessionId: 's-capabilities'
    } as Request)) as Response & { capabilities: unknown[] }
    t.is(response.type, 'getRuntimeCapabilities')
    t.is(response.capabilities.length, 1, 'the session sees the runtime-wide report')
    await t.exception(
      () => send({ type: 'getRuntimeCapabilities', sessionId: 'never-opened' } as Request),
      SessionNotOpenError
    )
  } finally {
    clearSessions()
    await close()
    clearPlugins()
  }
})

test('registerPlugin accepts a third-party plugin that provides a QVAC contract', function (t) {
  clearPlugins()
  try {
    registerPlugin(makePlugin('acme-asr', ['transcribe'], [CAPABILITY_CONTRACTS.transcription]))
    t.alike(getProvidedCapabilities(), [
      { id: 'transcription', version: 1, operations: ['transcribe'], partialOperations: [] }
    ])
  } finally {
    clearPlugins()
  }
})

test('registerPlugin rejects a malformed capability ID or version', function (t) {
  clearPlugins()
  try {
    assertRejected(
      t,
      makePlugin('a', ['x'], [thirdParty('Acme.Diarization', 1, ['x'])]),
      /capability id/
    )
    assertRejected(t, makePlugin('b', ['x'], [thirdParty('acme..x', 1, ['x'])]), /capability id/)
    assertRejected(t, makePlugin('c', ['x'], [thirdParty('acme.x', 0, ['x'])]), /at least 1/)
    assertRejected(t, makePlugin('d', ['x'], [thirdParty('acme.x', 1.5, ['x'])]), /integer/)
    assertRejected(t, makePlugin('e', ['x'], [thirdParty('acme.x', 1, [])]), /required operation/)
  } finally {
    clearPlugins()
  }
})

test('registerPlugin rejects an undotted ID or major QVAC does not define', function (t) {
  clearPlugins()
  try {
    assertRejected(
      t,
      makePlugin('a', ['x'], [thirdParty('diarization', 1, ['x'])]),
      /not a QVAC capability contract/
    )
    assertRejected(
      t,
      makePlugin('b', ['transcribe'], [thirdParty('transcription', 2, ['transcribe'])]),
      /"transcription@2" is not defined by this runtime, which defines transcription@1/
    )
  } finally {
    clearPlugins()
  }
})

test('a QVAC declaration from an earlier or later table registers, and the report uses the runtime table', function (t) {
  clearPlugins()
  try {
    registerPlugin(
      makePlugin(
        'built-against-older-table',
        ['transcribe', 'transcribeStream'],
        [thirdParty('transcription', 1, ['transcribe'])]
      )
    )
    registerPlugin(
      makePlugin(
        'built-against-newer-table',
        ['transcribe', 'transcribeBatch'],
        [thirdParty('transcription', 1, ['transcribe'], ['transcribeStream', 'transcribeBatch'])]
      )
    )
    registerPlugin(makePlugin('names-only', ['transcribe'], [{ id: 'transcription', version: 1 }]))
    t.alike(getProvidedCapabilities(), [
      {
        id: 'transcription',
        version: 1,
        operations: ['transcribe'],
        partialOperations: ['transcribeStream']
      }
    ])
  } finally {
    clearPlugins()
  }
})

test('registerPlugin rejects a dotted declaration without operations', function (t) {
  clearPlugins()
  try {
    assertRejected(
      t,
      makePlugin('a', ['diarize'], [{ id: 'acme.diarization', version: 1 }]),
      /must list its operations/
    )
  } finally {
    clearPlugins()
  }
})

test('registerPlugin rejects a contract whose required operation has no handler', function (t) {
  clearPlugins()
  try {
    assertRejected(
      t,
      makePlugin('a', ['embed'], [CAPABILITY_CONTRACTS.embedding]),
      /missing: embedBatch/
    )
  } finally {
    clearPlugins()
  }
})

test('registerPlugin rejects one handler listed by two contract IDs', function (t) {
  clearPlugins()
  try {
    assertRejected(
      t,
      makePlugin(
        'a',
        ['run'],
        [thirdParty('acme.one', 1, ['run']), thirdParty('acme.two', 1, ['run'])]
      ),
      /listed by capabilities "acme.one" and "acme.two"/
    )
  } finally {
    clearPlugins()
  }
})

test('registerPlugin rejects a repeated contract or operation', function (t) {
  clearPlugins()
  try {
    assertRejected(
      t,
      makePlugin('a', ['ocrStream'], [CAPABILITY_CONTRACTS.ocr, CAPABILITY_CONTRACTS.ocr]),
      /lists capability "ocr@1" twice/
    )
    assertRejected(
      t,
      makePlugin('b', ['run'], [thirdParty('acme.x', 1, ['run'], ['run'])]),
      /more than once/
    )
  } finally {
    clearPlugins()
  }
})

test('providers of one third-party contract may list different optional operations', function (t) {
  clearPlugins()
  try {
    registerPlugin(makePlugin('older', ['run'], [thirdParty('acme.x', 1, ['run'])]))
    registerPlugin(
      makePlugin('newer', ['run', 'extra'], [thirdParty('acme.x', 1, ['run'], ['extra'])])
    )
    t.alike(getProvidedCapabilities(), [
      { id: 'acme.x', version: 1, operations: ['run'], partialOperations: ['extra'] }
    ])
  } finally {
    clearPlugins()
  }
})

test('registerPlugin rejects a third-party provider whose required operations differ', function (t) {
  clearPlugins()
  try {
    registerPlugin(makePlugin('first', ['run'], [thirdParty('acme.x', 1, ['run'])]))
    assertRejected(
      t,
      makePlugin('second', ['run', 'stop'], [thirdParty('acme.x', 1, ['run', 'stop'])]),
      /requires \[run, stop\], but plugin "first" requires \[run\]/
    )
  } finally {
    clearPlugins()
  }
})
