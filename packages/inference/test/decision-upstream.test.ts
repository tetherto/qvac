// Upstream decision engines (QVAC-26667): request/result conversion, the
// depth guard, the decide op, and the adapter against the installed addon.
//
// MOCKED: the decide-op tests below register a stub engine whose responses
// were recorded from @qvac/embed-llamacpp's DecisionEngine on
// ggml-org/tinyopenjev-for-testing-gguf. They exercise the plugin's
// conversion and lifecycle, not native execution; that is covered by
// embed-llamacpp's decision-engine.test.js and the prototype's end-to-end run.
import test from 'brittle'
import Buffer from 'bare-buffer'
import fs from 'bare-fs'
import os from 'bare-os'
import path from 'bare-path'
import { registerModel, unregisterModel, type AnyModel } from '@/runtime/model-registry'
import { getRequestRegistry } from '@/runtime/request-context'
import { decide } from '@/plugins/builtin/llamacpp-decision/ops/decide'
import {
  DecisionModel,
  DECISION_INVALID_REQUEST,
  fromUpstreamResult,
  toUpstreamConfig,
  toUpstreamRequest,
  type UpstreamDecisionInfo,
  type UpstreamResult
} from '@/plugins/builtin/llamacpp-decision/upstream'
import { DECISION_MAX_JSON_DEPTH, decisionStateSchema, ModelType } from '@/schemas/index'
import {
  InferenceCancelledError as InferenceCancelled,
  ModelLoadFailedError as ModelLoadFailed,
  RequestValidationFailedError as RequestValidationFailed
} from '@/errors/index'

// brittle types the error argument as a no-argument constructor.
type ErrorClass = new () => Error
const InferenceCancelledError = InferenceCancelled as unknown as ErrorClass
const ModelLoadFailedError = ModelLoadFailed as unknown as ErrorClass
const RequestValidationFailedError = RequestValidationFailed as unknown as ErrorClass

const openjev: UpstreamDecisionInfo = {
  decision_type: 'openjev',
  noul: 'probability',
  joint: false,
  shared_prefix: true,
  images: false,
  audio: false,
  score_levels: { min: 2, max: 10 },
  max_json_depth: 128,
  n_ctx: 1024,
  model: 'tinyopenjev'
}
const lev: UpstreamDecisionInfo = { ...openjev, decision_type: 'lev', noul: 'expected_rating' }

// Recorded from DecisionEngine on tinyopenjev (route, urgency, refund).
const recorded: UpstreamResult = {
  model: 'tinyopenjev',
  answers: {
    route: {
      type: 'choice',
      choice: 'billing',
      probabilities: { support: 0.41563274681653783, billing: 0.5843672531834623 },
      confidence: 0.16873450636692455
    },
    urgency: {
      type: 'score',
      score: 1.0975926031887924,
      legend: { '0': 'not urgent', '1': 'somewhat urgent', '2': 'very urgent' },
      probabilities: { '0': 0.31, '1': 0.28, '2': 0.41 },
      confidence: 0.02
    },
    refund: { type: 'noul', noul: 0.4709828670544308 }
  },
  usage: { input_tokens: 412, output_tokens: 0 }
}

const questions = {
  route: {
    type: 'choice' as const,
    instructions: 'Which team?',
    criteria: { support: 'Account questions', billing: 'Payments' }
  },
  urgency: {
    type: 'score' as const,
    instructions: 'How urgent?',
    criteria: ['not urgent', 'somewhat urgent', 'very urgent']
  },
  refund: { type: 'noul' as const, instructions: 'Refund requested?' }
}

function nested(depth: number): unknown {
  return JSON.parse('['.repeat(depth) + ']'.repeat(depth))
}

// --- request conversion -----------------------------------------------------

test('choice arrays become option keys and map back to typed values', (t) => {
  const { body, keyMaps } = toUpstreamRequest(
    {
      questions: {
        flag: { type: 'choice', instructions: 'Which?', criteria: [true, 2, 'three'] }
      }
    },
    'state',
    openjev
  )
  t.alike(body.questions.flag, {
    type: 'choice',
    instructions: 'Which?',
    criteria: { true: null, '2': null, three: null }
  })
  const answer = fromUpstreamResult(
    {
      model: 'm',
      answers: {
        flag: {
          type: 'choice',
          choice: '2',
          probabilities: { true: 0.1, '2': 0.8, three: 0.1 },
          confidence: 0.5
        }
      },
      usage: { input_tokens: 1, output_tokens: 0 }
    },
    keyMaps
  ).answers.flag
  t.is(answer?.type === 'choice' && answer.choice, 2, 'the number comes back as a number')
})

test('colliding and duplicate choice values are rejected', (t) => {
  for (const criteria of [
    [true, 'true'],
    [1, '1'],
    ['a', 'a']
  ]) {
    t.exception(
      () =>
        toUpstreamRequest(
          { questions: { q: { type: 'choice', instructions: '?', criteria } } },
          's',
          openjev
        ),
      RequestValidationFailedError,
      JSON.stringify(criteria)
    )
  }
})

test('choice records pass through with the caller keys', (t) => {
  const { body, keyMaps } = toUpstreamRequest({ questions }, 'state', openjev)
  t.alike(body.questions.route, questions.route)
  t.absent(keyMaps.get('route'), 'records need no key map')
})

test('question names that are Object.prototype members convert like any other', (t) => {
  const answer = (choice: string) => ({
    type: 'choice' as const,
    choice,
    probabilities: { [choice]: 1 },
    confidence: 1
  })
  for (const name of ['toString', 'constructor', 'hasOwnProperty']) {
    const { keyMaps } = toUpstreamRequest(
      {
        questions: {
          [name]: { type: 'choice', instructions: '?', criteria: { a: 'A', b: 'B' } },
          typed: { type: 'choice', instructions: '?', criteria: [1, 2] }
        }
      },
      's',
      openjev
    )
    const { answers } = fromUpstreamResult(
      {
        model: 'm',
        answers: { [name]: answer('b'), typed: answer('2') },
        usage: { input_tokens: 1, output_tokens: 0 }
      },
      keyMaps
    )
    const record = answers[name]
    const typed = answers['typed']
    t.is(record?.type === 'choice' && record.choice, 'b', `record choice named ${name}`)
    t.is(typed?.type === 'choice' && typed.choice, 2, `typed choice next to ${name}`)
  }
})

test('score levels outside the model range are rejected', (t) => {
  for (const count of [1, 11]) {
    t.exception(
      () =>
        toUpstreamRequest(
          {
            questions: {
              q: { type: 'score', instructions: '?', criteria: Array(count).fill('level') }
            }
          },
          's',
          openjev
        ),
      RequestValidationFailedError,
      `${count} levels`
    )
  }
})

test('controls upstream engines do not support are rejected', (t) => {
  const cases = [
    { questions: { q: { type: 'noul' as const, instructions: '?', optionOrder: [1, 0] } } },
    {
      questions: {
        q: { type: 'noul' as const, instructions: '?', labels: { false: 'no', true: 'yes' } }
      }
    },
    { questions, maxLen: 64 },
    { questions, headMaxLen: 32 }
  ]
  for (const request of cases) {
    t.exception(() => toUpstreamRequest(request, 's', openjev), RequestValidationFailedError)
  }
})

test('requireProbability: lev is rejected, openjev passes and the flag stays in QVAC', (t) => {
  const request = {
    questions: { q: { type: 'noul' as const, instructions: '?', requireProbability: true } }
  }
  t.exception(() => toUpstreamRequest(request, 's', lev), /expected rating, not a probability/)
  const { body } = toUpstreamRequest(request, 's', openjev)
  t.alike(body.questions.q, { type: 'noul', instructions: '?' })
  // Without the flag, lev's noul is still available.
  t.execution(() =>
    toUpstreamRequest({ questions: { q: { type: 'noul', instructions: '?' } } }, 's', lev)
  )
})

test('upstream load options: supported keys map, others fail the load', (t) => {
  t.alike(toUpstreamConfig({ device: 'gpu', gpu_layers: 99, threads: 4 }), {
    device: 'gpu',
    gpu_layers: '99',
    threads: '4'
  })
  t.exception(() => toUpstreamConfig({ device: 'cpu', flash_attn: 'on' }), ModelLoadFailedError)
})

// --- result conversion -----------------------------------------------------

test('results: noul keeps no confidence, legends become text, usage is per state', (t) => {
  const converted = fromUpstreamResult(
    {
      ...recorded,
      answers: {
        ...recorded.answers,
        urgency: {
          type: 'score',
          score: 0.5,
          legend: { '0': { b: 1, a: [2] }, '1': null, '2': 'high' },
          probabilities: { '0': 0.5, '1': 0.25, '2': 0.25 },
          confidence: 0.1
        }
      }
    },
    new Map()
  )
  t.alike(converted.answers.refund, { type: 'noul', noul: 0.4709828670544308 })
  const urgency = converted.answers.urgency
  t.alike(urgency?.type === 'score' && urgency.legend, { '0': '{"a":[2],"b":1}', '2': 'high' })
  t.alike(converted.usage, { inputTokens: 412, outputTokens: 0 })
})

// --- depth guard ------------------------------------------------------------

test('the depth guard accepts 128 and rejects 129 and far deeper values', (t) => {
  t.is(DECISION_MAX_JSON_DEPTH, 128)
  t.ok(decisionStateSchema.safeParse(nested(128)).success, 'depth 128 accepted')
  const deep = decisionStateSchema.safeParse(nested(129))
  t.absent(deep.success)
  t.ok(
    deep.error?.issues.some((issue) => /nested more than 128 levels/.test(issue.message)),
    'depth 129 names the limit'
  )
  t.absent(decisionStateSchema.safeParse(nested(5000)).success, 'depth 5000 rejected, no overflow')
})

// --- decide op (MOCKED engine) ------------------------------------------------

type TestContext = { teardown(cleanup: () => void | Promise<void>): void }

function upstreamFixture(
  t: TestContext,
  id: string,
  info: UpstreamDecisionInfo,
  run: (body: unknown) => Promise<UpstreamResult>,
  cancel = async () => {}
) {
  const engine = {
    run: async (body: unknown) => ({ await: async () => [await run(body)] }),
    cancel,
    unload: async () => {},
    load: async () => {},
    info: () => info
  }
  const model = {
    kind: 'upstream',
    info,
    upstream: engine,
    cancel: () => engine.cancel()
  }
  registerModel(id, {
    model: model as unknown as AnyModel,
    path: '/tmp/openjev.gguf',
    config: {},
    modelType: ModelType.llamacppDecision
  })
  t.teardown(() => {
    unregisterModel(id)
  })
}

test('decide (mocked engine): single and batch results, in input order', async (t) => {
  const seen: unknown[] = []
  upstreamFixture(t, 'up-batch', openjev, async (body) => {
    seen.push((body as { state: unknown }).state)
    return recorded
  })
  const single = await decide({ type: 'decide', modelId: 'up-batch', state: 'one', questions })
  t.is((single.result as { model: string }).model, 'tinyopenjev')
  const batch = await decide({
    type: 'decide',
    modelId: 'up-batch',
    states: ['a', 'b', 'c'],
    questions
  })
  t.is((batch.result as unknown[]).length, 3)
  t.alike(seen, ['one', 'a', 'b', 'c'])
})

test('decide (mocked engine): a coded rejection becomes RequestValidationFailedError', async (t) => {
  upstreamFixture(t, 'up-invalid', openjev, async () => {
    const error = new Error('questions.q: too many options') as Error & { code: string }
    error.code = DECISION_INVALID_REQUEST
    throw error
  })
  await t.exception(
    decide({ type: 'decide', modelId: 'up-invalid', state: 's', questions }),
    RequestValidationFailedError
  )
})

test('decide (mocked engine): a failure mid-batch fails the whole call', async (t) => {
  let calls = 0
  upstreamFixture(t, 'up-midfail', openjev, async () => {
    calls += 1
    if (calls === 2) throw new Error('decode failed')
    return recorded
  })
  await t.exception(
    decide({ type: 'decide', modelId: 'up-midfail', states: ['a', 'b', 'c'], questions }),
    /decode failed/
  )
  t.is(calls, 2, 'the remaining state does not run')
})

test('decide (mocked engine): validation runs before any state', async (t) => {
  let calls = 0
  upstreamFixture(t, 'up-validate', lev, async () => {
    calls += 1
    return recorded
  })
  await t.exception(
    decide({
      type: 'decide',
      modelId: 'up-validate',
      states: ['a', 'b'],
      questions: { q: { type: 'noul', instructions: '?', requireProbability: true } }
    }),
    RequestValidationFailedError
  )
  t.is(calls, 0)
})

test('decide (mocked engine): cancel stops the run and cancels the engine', async (t) => {
  let cancelled = false
  let release: () => void = () => {}
  upstreamFixture(
    t,
    'up-cancel',
    openjev,
    () =>
      new Promise((resolve, reject) => {
        release = () => reject(new Error('Job cancelled'))
        void resolve
      }),
    async () => {
      cancelled = true
      release()
    }
  )
  const running = decide({
    type: 'decide',
    modelId: 'up-cancel',
    requestId: 'up-cancel-req',
    state: 's',
    questions
  })
  await new Promise<void>((resolve) => setTimeout(resolve, 10))
  getRequestRegistry().cancel({ requestId: 'up-cancel-req' })
  await t.exception(running, InferenceCancelledError)
  t.ok(cancelled, 'the engine was cancelled')
})

// --- the adapter against the installed addon ---------------------------------

// A minimal GGUF header naming an architecture and nothing else.
function writeGguf(file: string, arch: string) {
  const key = Buffer.from('general.architecture')
  const value = Buffer.from(arch)
  const parts = [
    Buffer.from('GGUF'),
    u32(3),
    u64(0),
    u64(1),
    u64(key.length),
    key,
    u32(8),
    u64(value.length),
    value
  ]
  fs.writeFileSync(file, Buffer.concat(parts))
}
function u32(n: number) {
  const b = Buffer.alloc(4)
  b.writeUInt32LE(n)
  return b
}
function u64(n: number) {
  const b = Buffer.alloc(8)
  b.writeBigUInt64LE(BigInt(n))
  return b
}

test('upstream load: the plugin config, openclCacheDir included, reaches the engine', async (t) => {
  const file = path.join(os.tmpdir(), `decision-config-${Date.now()}.gguf`)
  writeGguf(file, 'openjev')
  t.teardown(() => fs.rmSync(file, { force: true }))
  const seen: Array<{ files: { model: string[] }; config: Record<string, unknown> }> = []
  class Engine {
    constructor(args: { files: { model: string[] }; config: Record<string, unknown> }) {
      seen.push(args)
    }
    load = () => Promise.resolve()
    unload = () => Promise.resolve()
    cancel = () => Promise.resolve()
    run = () => Promise.reject(new Error('not used'))
    info = () => openjev
  }
  const model = new DecisionModel({
    modelPath: file,
    files: [file],
    layaConfig: { device: 'gpu' },
    config: { device: 'gpu', gpu_layers: 99, openclCacheDir: '/data/user/0/app/cache' },
    engineClass: Engine
  })
  await model.load()
  t.is(model.kind, 'upstream')
  t.alike(seen, [
    {
      files: { model: [file] },
      config: { device: 'gpu', gpu_layers: '99', openclCacheDir: '/data/user/0/app/cache' },
      logger: undefined
    }
  ])
})

test('an addon without DecisionEngine: upstream models fail to load with a clear error', async (t) => {
  const embed = (await import('@qvac/embed-llamacpp')) as unknown as Record<string, unknown>
  if (typeof embed['DecisionEngine'] === 'function') {
    t.comment('the installed addon has DecisionEngine; this case needs one without it')
    return
  }
  const file = path.join(os.tmpdir(), `decision-adapter-${Date.now()}.gguf`)
  writeGguf(file, 'qwen35')
  t.teardown(() => fs.rmSync(file, { force: true }))
  const model = new DecisionModel({
    modelPath: file,
    files: [file],
    layaConfig: { device: 'cpu' },
    config: { device: 'cpu' }
  })
  await t.exception(model.load(), /needs @qvac\/embed-llamacpp with DecisionEngine/)
  t.is(model.kind, undefined, 'nothing was loaded')
})
