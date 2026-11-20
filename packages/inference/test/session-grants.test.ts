import test from 'brittle'
import env from 'bare-env'
import os from 'bare-os'
import path from 'bare-path'
import { z } from 'zod'
import { send, stream, duplex, close } from '@/dispatch'
import { clearPlugins, registerPlugin } from '@/plugins'
import { registry } from '@/registry'
import { QVAC_OPERATION_CALL_SHAPES } from '@/plugins/capabilities'
import { registerModel, unregisterModel, type AnyModel } from '@/runtime/model-registry'
import { clearSessions, getSessionGrant } from '@/runtime/session-registry'
import {
  SESSION_GRANT_RULES,
  assertSessionGrant,
  qvacOperationPermission
} from '@/runtime/session-grants'
import {
  CapabilityNotGrantedError as CapabilityNotGranted,
  SessionGrantInvalidError as SessionGrantInvalid,
  OwnerOnlyError as OwnerOnly,
  RequestValidationFailedError as RequestValidationFailed
} from '@/errors'
import {
  CAPABILITY_CONTRACTS,
  RUNTIME_PERMISSION_OPERATIONS,
  capabilityPermissions,
  type CapabilityDeclaration,
  type Request
} from '@/schemas'
import { definePlugin, defineHandler, defineDuplexHandler, type QvacPlugin } from '@/schemas/plugin'

env['HOME'] = path.join(os.tmpdir(), `qvac-inference-grants-test-${os.pid()}`)

const CapabilityNotGrantedError = CapabilityNotGranted as unknown as new () => Error
const SessionGrantInvalidError = SessionGrantInvalid as unknown as new () => Error
const OwnerOnlyError = OwnerOnly as unknown as new () => Error
const RequestValidationFailedError = RequestValidationFailed as unknown as new () => Error

// Prefixed so a test name never matches a model type reserved for built-ins.
function testModelType(name: string): string {
  return `acme-${name}`
}

function makePlugin(
  modelType: string,
  handlerNames: string[],
  provides?: readonly CapabilityDeclaration[]
): QvacPlugin {
  // Each handler takes the call shape the runtime uses for a QVAC operation of
  // that name, since registration rejects any other; other names are replies.
  const handlers = Object.fromEntries(
    handlerNames.map((name) => {
      const shape = QVAC_OPERATION_CALL_SHAPES[name] ?? 'reply'
      return [
        name,
        defineHandler({
          requestSchema: z.object({}).passthrough(),
          responseSchema: z.object({ ok: z.boolean() }),
          streaming: shape !== 'reply',
          ...(shape === 'duplex' && { duplex: true }),
          handler:
            shape === 'reply'
              ? async function () {
                  return { ok: true }
                }
              : async function* () {
                  yield { ok: true }
                }
        } as never)
      ]
    })
  )
  return definePlugin({
    modelType: testModelType(modelType),
    displayName: `Display ${modelType}`,
    addonPackage: `@acme/addon-${modelType}`,
    loadConfigSchema: z.object({}),
    createModel() {
      return { model: { load: async function () {} } }
    },
    handlers,
    ...(provides && { provides })
  })
}

function addModel(modelId: string, modelType: string): void {
  registerModel(modelId, {
    model: { load: async () => {}, unload: async () => {} } as unknown as AnyModel,
    path: '/tmp/model.bin',
    config: {},
    modelType: testModelType(modelType) as never
  })
}

async function open(sessionId: string, grant?: string[]): Promise<void> {
  await send({ type: 'openSession', sessionId, ...(grant && { grant }) } as Request)
}

function asSession(sessionId: string, request: Record<string, unknown>): Request {
  return { ...request, sessionId } as unknown as Request
}

function refusal(fn: () => void): CapabilityNotGranted | undefined {
  try {
    fn()
  } catch (error) {
    if (error instanceof CapabilityNotGranted) return error
    throw error
  }
  return undefined
}

async function withRuntime(plugins: QvacPlugin[], body: () => Promise<void>): Promise<void> {
  clearPlugins()
  clearSessions()
  for (const plugin of plugins) registerPlugin(plugin)
  try {
    await body()
  } finally {
    clearSessions()
    await close()
    clearPlugins()
  }
}

test('every request type the runtime dispatches has a grant rule', function (t) {
  for (const type of Object.keys(registry)) {
    t.ok(type in SESSION_GRANT_RULES, `${type} has a rule`)
  }
})

test('every capability rule maps to a QVAC contract operation', function (t) {
  for (const [type, rule] of Object.entries(SESSION_GRANT_RULES)) {
    if (rule === 'capability') {
      t.ok(qvacOperationPermission(type), `${type} maps to ${qvacOperationPermission(type)}`)
    } else if (typeof rule === 'object') {
      t.ok(qvacOperationPermission(rule.operation), `${type} maps through ${rule.operation}`)
    }
  }
})

test('the runtime rules are exactly the runtime permission operations', function (t) {
  const runtime = Object.entries(SESSION_GRANT_RULES)
    .filter(([, rule]) => rule === 'runtime')
    .map(([type]) => type)
    .sort()
  t.alike(runtime, [...RUNTIME_PERMISSION_OPERATIONS].sort())
})

test('capabilityPermissions names every operation of a contract', function (t) {
  t.alike(capabilityPermissions(CAPABILITY_CONTRACTS.transcription), [
    'transcription/transcribe',
    'transcription/transcribeStream'
  ])
})

test('a granted operation passes and its sibling in the same contract is refused', async function (t) {
  await withRuntime(
    [makePlugin('asr', ['transcribe', 'transcribeStream'], [CAPABILITY_CONTRACTS.transcription])],
    async () => {
      await open('s', ['transcription/transcribe'])
      t.absent(
        refusal(() => assertSessionGrant(asSession('s', { type: 'transcribe', modelId: 'm' }))),
        'transcribe is granted'
      )
      const error = refusal(() =>
        assertSessionGrant(asSession('s', { type: 'transcribeStream', modelId: 'm' }))
      )
      t.is(error?.required, 'transcription/transcribeStream')
      t.is(error?.operation, 'transcribeStream')
      t.is(error?.sessionId, 's')
    }
  )
})

test('dispatch refuses an ungranted call before its handler runs', async function (t) {
  await withRuntime(
    [makePlugin('asr', ['transcribe'], [CAPABILITY_CONTRACTS.transcription])],
    async () => {
      await open('s', ['transcription/transcribe'])
      await t.exception(
        () => send(asSession('s', { type: 'embed', modelId: 'missing', text: 'a' })),
        CapabilityNotGrantedError,
        'refused even though the model does not exist'
      )
      const heartbeat = await send(asSession('s', { type: 'heartbeat' }))
      t.is(heartbeat.type, 'heartbeat', 'a grant-free request runs')
    }
  )
})

test('completionOrchestrate needs completion/completionStream', async function (t) {
  await withRuntime(
    [makePlugin('llm', ['completionStream'], [CAPABILITY_CONTRACTS.completion])],
    async () => {
      await open('granted', ['completion/completionStream'])
      await open('other', ['completion/calcTokens'])
      const request = { type: 'completionOrchestrate', modelId: 'm' }
      t.absent(refusal(() => assertSessionGrant(asSession('granted', request))))
      t.is(
        refusal(() => assertSessionGrant(asSession('other', request)))?.required,
        'completion/completionStream'
      )
    }
  )
})

test('runtime operations need their runtime permission', async function (t) {
  await withRuntime(
    [makePlugin('asr', ['transcribe'], [CAPABILITY_CONTRACTS.transcription])],
    async () => {
      await open('none', [])
      await open('loader', ['runtime/loadModel'])
      for (const type of RUNTIME_PERMISSION_OPERATIONS) {
        t.is(
          refusal(() => assertSessionGrant(asSession('none', { type })))?.required,
          `runtime/${type}`,
          `${type} refused without runtime/${type}`
        )
      }
      t.absent(refusal(() => assertSessionGrant(asSession('loader', { type: 'loadModel' }))))
      t.ok(refusal(() => assertSessionGrant(asSession('loader', { type: 'downloadAsset' }))))
    }
  )
})

test('grant-free requests pass with an empty grant', async function (t) {
  await withRuntime(
    [makePlugin('asr', ['transcribe'], [CAPABILITY_CONTRACTS.transcription])],
    async () => {
      await open('s', [])
      for (const [type, rule] of Object.entries(SESSION_GRANT_RULES)) {
        if (rule !== 'free') continue
        t.absent(
          refusal(() => assertSessionGrant(asSession('s', { type }))),
          `${type} is free`
        )
      }
    }
  )
})

test('the owner and an unrestricted session are never checked', async function (t) {
  await withRuntime(
    [makePlugin('asr', ['transcribe'], [CAPABILITY_CONTRACTS.transcription])],
    async () => {
      await open('free')
      t.is(getSessionGrant('free'), undefined)
      for (const type of ['embed', 'downloadAsset', 'loadModel']) {
        t.absent(
          refusal(() => assertSessionGrant({ type } as unknown as Request)),
          `owner: ${type}`
        )
        t.absent(
          refusal(() => assertSessionGrant(asSession('free', { type }))),
          `unrestricted: ${type}`
        )
      }
    }
  )
})

test('owner-only operations stay refused with OwnerOnlyError', async function (t) {
  await withRuntime(
    [makePlugin('asr', ['transcribe'], [CAPABILITY_CONTRACTS.transcription])],
    async () => {
      await open('s', ['transcription/transcribe'])
      await t.exception(() => send(asSession('s', { type: 'suspend' })), OwnerOnlyError)
    }
  )
})

test('pluginInvoke needs the permission of the contract that lists the handler', async function (t) {
  const vla = makePlugin(
    'vla',
    ['vlaRun', 'vlaHparams', 'vlaSetEmbodiment', 'debugDump'],
    [CAPABILITY_CONTRACTS.visionLanguageAction]
  )
  await withRuntime([vla], async () => {
    addModel('vla-model', 'vla')
    try {
      await open('s', ['vision-language-action/vlaRun'])
      const invoke = (handler: string) =>
        asSession('s', { type: 'pluginInvoke', modelId: 'vla-model', handler, params: {} })

      t.absent(
        refusal(() => assertSessionGrant(invoke('vlaRun'))),
        'granted handler'
      )
      t.is(
        refusal(() => assertSessionGrant(invoke('vlaHparams')))?.required,
        'vision-language-action/vlaHparams'
      )
      const undeclared = refusal(() => assertSessionGrant(invoke('debugDump')))
      t.is(undeclared?.required, null, 'a handler in no contract is refused')
      t.is(undeclared?.operation, 'debugDump')

      const reply = await send(invoke('vlaRun'))
      t.is(reply.type, 'pluginInvoke', 'dispatch runs the granted handler')
      await t.exception(() => send(invoke('vlaHparams')), CapabilityNotGrantedError)

      t.absent(
        refusal(() => assertSessionGrant(invoke('noSuchHandler'))),
        'a missing handler is left to the handler lookup'
      )
      t.absent(
        refusal(() =>
          assertSessionGrant(
            asSession('s', { type: 'pluginInvoke', modelId: 'gone', handler: 'vlaRun' })
          )
        ),
        'a missing model is left to the handler lookup'
      )
    } finally {
      unregisterModel('vla-model')
    }
  })
})

test('pluginInvoke follows the model plugin own declarations', async function (t) {
  const first = makePlugin(
    'first',
    ['run', 'extra'],
    [{ id: 'acme.tool', version: 1, operations: ['run'] }]
  )
  const second = makePlugin(
    'second',
    ['run', 'extra'],
    [{ id: 'acme.tool', version: 1, operations: ['run'], optionalOperations: ['extra'] }]
  )
  const legacy = makePlugin('legacy', ['transcribe'])
  await withRuntime([first, second, legacy], async () => {
    addModel('first-model', 'first')
    addModel('second-model', 'second')
    addModel('legacy-model', 'legacy')
    try {
      await open('s', ['acme.tool/run', 'acme.tool/extra'])
      const invoke = (modelId: string, handler: string) =>
        asSession('s', { type: 'pluginInvoke', modelId, handler, params: {} })

      t.absent(refusal(() => assertSessionGrant(invoke('second-model', 'extra'))))
      t.is(
        refusal(() => assertSessionGrant(invoke('first-model', 'extra')))?.required,
        null,
        'first does not declare extra, even though second does'
      )
      t.is(
        refusal(() => assertSessionGrant(invoke('legacy-model', 'transcribe')))?.required,
        null,
        'a plugin without provides is not reachable through pluginInvoke'
      )
    } finally {
      unregisterModel('first-model')
      unregisterModel('second-model')
      unregisterModel('legacy-model')
    }
  })
})

test('a typed request maps by operation name, whatever the model plugin declares', async function (t) {
  await withRuntime(
    [
      makePlugin('asr', ['transcribe'], [CAPABILITY_CONTRACTS.transcription]),
      makePlugin('legacy', ['transcribe'])
    ],
    async () => {
      addModel('legacy-model', 'legacy')
      try {
        await open('s', ['transcription/transcribe'])
        t.absent(
          refusal(() =>
            assertSessionGrant(asSession('s', { type: 'transcribe', modelId: 'legacy-model' }))
          )
        )
      } finally {
        unregisterModel('legacy-model')
      }
    }
  )
})

// Through the engine's own stream and duplex entry points, the ones the SDK
// worker calls, with handlers that answer: a granted call runs to completion,
// an ungranted one is refused before its handler starts.
test('granted stream and duplex calls run end to end and ungranted ones are refused', async function (t) {
  let started = 0
  const asr = definePlugin({
    modelType: testModelType('asr-live'),
    displayName: 'Live ASR',
    addonPackage: '@acme/addon-asr-live',
    loadConfigSchema: z.object({}),
    createModel() {
      return { model: { load: async function () {} } }
    },
    provides: [CAPABILITY_CONTRACTS.transcription],
    handlers: {
      transcribe: defineHandler({
        requestSchema: z.object({}).passthrough(),
        responseSchema: z.object({}).passthrough(),
        streaming: true,
        handler: async function* () {
          started++
          yield { type: 'transcribe', text: 'hello', done: true }
        }
      }),
      transcribeStream: defineDuplexHandler({
        requestSchema: z.object({}).passthrough(),
        responseSchema: z.object({}).passthrough(),
        streaming: true,
        duplex: true,
        handler: async function* (_request, input) {
          started++
          let bytes = 0
          for await (const chunk of input) bytes += chunk.length
          yield { type: 'transcribeStream', text: `${bytes} bytes`, done: true }
        }
      })
    }
  })
  await withRuntime([asr], async () => {
    addModel('live-model', 'asr-live')
    try {
      await open('batch', ['transcription/transcribe'])
      await open('both', capabilityPermissions(CAPABILITY_CONTRACTS.transcription))
      const transcribe = (sessionId: string) =>
        asSession(sessionId, {
          type: 'transcribe',
          modelId: 'live-model',
          audioChunk: { type: 'base64', value: 'AAAA' }
        })
      const transcribeStream = (sessionId: string) =>
        asSession(sessionId, { type: 'transcribeStream', modelId: 'live-model' })

      const frames: Array<{ text?: string }> = []
      for await (const frame of stream(transcribe('batch'))) frames.push(frame as { text?: string })
      t.is(frames.at(-1)?.text, 'hello', 'a granted stream call returns its result')

      await t.exception(
        () => duplex(transcribeStream('batch')),
        CapabilityNotGrantedError,
        'a duplex call outside the grant is refused'
      )
      t.is(started, 1, 'the refused handler never started')

      const session = await duplex(transcribeStream('both'))
      session.requestStream.write(new Uint8Array([1, 2, 3]))
      session.requestStream.end()
      let output = ''
      for await (const chunk of session.responseStream) output += chunk.toString()
      t.ok(output.includes('3 bytes'), 'a granted duplex call streams its input through')
      t.is(started, 2)
    } finally {
      unregisterModel('live-model')
    }
  })
})

test('openSession validates the grant and opens no session on failure', async function (t) {
  await withRuntime(
    [
      makePlugin('asr', ['transcribe', 'transcribeStream'], [CAPABILITY_CONTRACTS.transcription]),
      makePlugin('tool', ['run'], [{ id: 'acme.tool', version: 1, operations: ['run'] }])
    ],
    async () => {
      for (const [grant, why] of [
        [['transcription'], 'malformed'],
        [['Transcription/transcribe'], 'malformed ID'],
        [[''], 'malformed empty'],
        [['transcription/transcribe', 'transcription/transcribe'], 'duplicate'],
        [['embedding/embed'], 'no plugin declares embedding'],
        [['transcription/translate'], 'not an operation of transcription'],
        [['runtime/rag'], 'rag has no permission'],
        [['runtime/heartbeat'], 'heartbeat needs no permission'],
        [['acme.tool/other'], 'not an operation of acme.tool']
      ] as const) {
        await t.exception(() => open(`bad-${why}`, [...grant]), SessionGrantInvalidError, why)
        t.is(getSessionGrant(`bad-${why}`), undefined, `no session for ${why}`)
      }
      await t.exception(
        () => open('bad-type', [1] as unknown as string[]),
        RequestValidationFailedError,
        'a grant entry that is not a string fails the request schema'
      )

      await open('ok', [
        ...capabilityPermissions(CAPABILITY_CONTRACTS.transcription),
        'acme.tool/run',
        'runtime/loadModel'
      ])
      t.alike([...(getSessionGrant('ok') ?? [])].sort(), [
        'acme.tool/run',
        'runtime/loadModel',
        'transcription/transcribe',
        'transcription/transcribeStream'
      ])
      await open('empty', [])
      t.alike([...(getSessionGrant('empty') ?? ['unset'])], [], 'an empty grant is kept')
    }
  )
})

test('SessionGrantInvalidError and CapabilityNotGrantedError carry their typed fields', function (t) {
  const invalid = new SessionGrantInvalid('s', 'x/y', 'reason')
  t.alike(invalid.toErrorResponseFields(), {
    sessionId: 's',
    permission: 'x/y',
    details: 'reason'
  })
  const refused = new CapabilityNotGranted('embed', 's', 'embedding/embed')
  t.alike(refused.toErrorResponseFields(), {
    operation: 'embed',
    sessionId: 's',
    required: 'embedding/embed'
  })
  t.ok(refused.message.includes('embedding/embed'))
  t.ok(new CapabilityNotGranted('debugDump', 's', null).message.includes('no capability contract'))
})
