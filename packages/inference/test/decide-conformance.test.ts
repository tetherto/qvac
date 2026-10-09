import test from 'brittle'
import fs from 'bare-fs'
import path from 'bare-path'
import { fileURLToPath } from 'bare-url'
import type { DecideParams } from '@/schemas/decide'
import { decide } from '@/plugins/ops/decide'
import { registerModel, unregisterModel } from '@/runtime/model-registry'
import { ModelType } from '@/schemas/index'
import { getRequestRegistry } from '@/runtime/request-context'
import {
  ContextOverflowError,
  DecideFailedError,
  InferenceCancelledError,
  ModelNotFoundError,
  ModelOperationNotSupportedError
} from '@/errors/index'

interface FixtureFile {
  id: string
  request?: {
    state?: unknown
    questions?: Record<string, unknown>
    images?: string[]
    omitted?: boolean
    raw_body?: string
  }
  response?: { answers: Record<string, unknown>; usage: { output_tokens: number } }
  error?: { skipped?: boolean }
}

type RunResult = {
  iterate: () => AsyncIterable<unknown>
  await: () => Promise<unknown>
  cancel: () => Promise<void>
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys)
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      out[key] = sortKeys((value as Record<string, unknown>)[key])
    }
    return out
  }
  return value
}

function canonical(request: { state?: unknown; questions?: unknown; images?: unknown }): string {
  const body: Record<string, unknown> = {
    state: request.state,
    questions: request.questions
  }
  if (request.images !== undefined) body.images = request.images
  return JSON.stringify(sortKeys(body))
}

function loadFixtures(): FixtureFile[] {
  const dir = fileURLToPath(new URL('../../fixtures/decide/', import.meta.url))
  return fs
    .readdirSync(dir)
    .filter((name: string) => name.endsWith('.json'))
    .map((name: string) => JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8')) as FixtureFile)
}

function replayable(fixture: FixtureFile): boolean {
  const request = fixture.request
  if (!request || request.omitted || request.raw_body || fixture.error?.skipped) return false
  if (!fixture.response || !request.questions) return false
  return true
}

function answered(body: unknown): RunResult {
  return {
    iterate() {
      return (async function* () {})()
    },
    async await() {
      return body
    },
    async cancel() {}
  }
}

function register(modelId: string, run: (input: unknown) => Promise<RunResult>) {
  registerModel(modelId, {
    model: {
      async load() {},
      async unload() {},
      async pause() {},
      run,
      addon: { async cancel() {} }
    } as unknown as Parameters<typeof registerModel>[1]['model'],
    path: '/tmp/laya.gguf',
    config: {},
    modelType: ModelType.llamacppDecision
  } as Parameters<typeof registerModel>[1])
}

export async function decisionConformance(
  addonFactory: () => (input: unknown) => Promise<RunResult>
): Promise<number> {
  const fixtures = loadFixtures().filter(replayable)
  if (fixtures.length === 0) throw new Error('no replayable decision fixtures')
  let ran = 0
  for (const fixture of fixtures) {
    ran += 1
    const modelId = `decide-conf-${fixture.id}-${ran}`
    register(modelId, addonFactory())
    try {
      const result = await decide({
        modelId,
        state: fixture.request!.state,
        questions: fixture.request!.questions,
        ...(fixture.request!.images ? { images: fixture.request!.images } : {})
      } as DecideParams)
      if (JSON.stringify(result.answers) !== JSON.stringify(fixture.response!.answers)) {
        throw new Error(`${fixture.id} answers diverged from the fixture`)
      }
      if (result.usage.output_tokens !== 0) {
        throw new Error(`${fixture.id} output_tokens is not 0`)
      }
    } finally {
      unregisterModel(modelId)
    }
  }
  return ran
}

function fixtureIndex(): Map<string, FixtureFile['response']> {
  const index = new Map<string, FixtureFile['response']>()
  for (const fixture of loadFixtures().filter(replayable)) {
    const key = canonical(fixture.request!)
    const previous = index.get(key)
    if (previous && JSON.stringify(previous) !== JSON.stringify(fixture.response)) {
      throw new Error(`fixture collision on ${fixture.id}`)
    }
    index.set(key, fixture.response)
  }
  return index
}

test('decisionConformance replays dev fixtures through the mock addon', async (t) => {
  const index = fixtureIndex()
  t.ok(index.size > 0, 'indexed at least one fixture')
  const ran = await decisionConformance(() => async (input) => {
    const found = index.get(canonical(input as { state: unknown; questions: unknown }))
    if (!found) throw new DecideFailedError('no fixture for this request')
    return answered(found)
  })
  t.ok(ran >= 10, 'replayed the dev successes')
})

test('decisionConformance fails when the addon returns an empty object', async (t) => {
  await t.exception(
    () => decisionConformance(() => async () => answered({})),
    DecideFailedError as unknown as new () => Error
  )
})

test('decide throws DecideFailedError when no fixture matches the request', async (t) => {
  const modelId = 'decide-missing-fixture'
  register(modelId, async () => {
    throw new DecideFailedError('no fixture for this request')
  })
  try {
    await t.exception(
      () =>
        decide({
          modelId,
          state: 'not in the fixture set',
          questions: { q: { type: 'noul', instructions: 'Is this recorded?' } }
        }),
      DecideFailedError as unknown as new () => Error
    )
  } finally {
    unregisterModel(modelId)
  }
})

test('decide propagates ContextOverflowError from the addon', async (t) => {
  const modelId = 'decide-overflow'
  register(modelId, async () => {
    throw new ContextOverflowError(693, 512, modelId)
  })
  try {
    await t.exception(
      () =>
        decide({
          modelId,
          state: 'x',
          questions: { q: { type: 'noul', instructions: 'ok?' } }
        }),
      ContextOverflowError as unknown as new () => Error
    )
  } finally {
    unregisterModel(modelId)
  }
})

test('decide propagates ModelOperationNotSupportedError for an image the addon rejects', async (t) => {
  const modelId = 'decide-images'
  register(modelId, async (input) => {
    const body = input as { images?: unknown }
    if (body.images) {
      throw new ModelOperationNotSupportedError(
        modelId,
        'llamacpp-decision',
        'images',
        ['decide'],
        []
      )
    }
    return answered({ answers: {}, usage: { input_tokens: 0, output_tokens: 0 } })
  })
  try {
    await t.exception(
      () =>
        decide({
          modelId,
          state: 'A scanned page.',
          questions: { table: { type: 'noul', instructions: 'Does the image contain a table?' } },
          images: ['data:image/png;base64,aa']
        }),
      ModelOperationNotSupportedError as unknown as new () => Error
    )
  } finally {
    unregisterModel(modelId)
  }
})

test('decide throws ModelNotFoundError when the model was not registered', async (t) => {
  await t.exception(
    () =>
      decide({
        modelId: 'missing-model',
        state: 'x',
        questions: { q: { type: 'noul', instructions: 'ok?' } }
      }),
    ModelNotFoundError as unknown as new () => Error
  )
})

test('decide cancel-by-requestId rejects with InferenceCancelledError', async (t) => {
  let release: () => void = () => {}
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  const modelId = 'decide-cancel'
  const requestId = 'decide-cancel-req'
  let addonCancelCalls = 0
  registerModel(modelId, {
    model: {
      async load() {},
      async unload() {},
      async pause() {},
      async run() {
        return {
          iterate() {
            return (async function* () {})()
          },
          async await() {
            await gate
            return {
              answers: { q: { type: 'noul', noul: 0.5 } },
              usage: { input_tokens: 1, output_tokens: 0 }
            }
          },
          async cancel() {}
        }
      },
      addon: {
        async cancel() {
          addonCancelCalls++
        }
      }
    } as unknown as Parameters<typeof registerModel>[1]['model'],
    path: '/tmp/laya.gguf',
    config: {},
    modelType: ModelType.llamacppDecision
  } as Parameters<typeof registerModel>[1])

  try {
    const pending = decide(
      {
        modelId,
        state: 'x',
        questions: { q: { type: 'noul', instructions: 'ok?' } }
      },
      requestId
    )
    await Promise.resolve()
    await Promise.resolve()
    const cancelled = getRequestRegistry().cancel({ requestId })
    t.is(cancelled, 1, 'registry cancelled exactly one entry')
    release()
    await t.exception(() => pending, InferenceCancelledError as unknown as new () => Error)
    t.ok(addonCancelCalls >= 1, 'registry abort forwarded to addon.cancel')
  } finally {
    unregisterModel(modelId)
  }
})
