import test from 'brittle'
import { findIncompatibility, type Direction } from '../scripts/contract/schema-compat'
import {
  baselineVersion,
  findMajorProblems,
  type ContractSnapshot
} from '../scripts/contract/capability-majors'
import { buildCapabilityBaseline } from '../scripts/contract/build-capability-baseline'

type Schema = Record<string, unknown>

function object(properties: Record<string, Schema>, required: string[] = []): Schema {
  return { type: 'object', properties, required, additionalProperties: false }
}

const text = { type: 'string' }

// Request rule: everything the old schema accepted is still accepted.
// Response rule: everything the new schema produces is accepted by the old one.
function compare(direction: Direction, before: unknown, after: unknown): string | undefined {
  return direction === 'request'
    ? findIncompatibility(before, {}, after, {}, { direction })
    : findIncompatibility(after, {}, before, {}, { direction })
}

const cases: Array<[string, Direction, unknown, unknown, RegExp | undefined]> = [
  [
    'request: unchanged apart from descriptions',
    'request',
    object({ a: { ...text, description: 'old' } }, ['a']),
    object({ a: { ...text, description: 'new' } }, ['a']),
    undefined
  ],
  [
    'request: new optional field',
    'request',
    object({ a: text }, ['a']),
    object({ a: text, b: text }, ['a']),
    undefined
  ],
  [
    'request: new required field',
    'request',
    object({ a: text }, ['a']),
    object({ a: text, b: text }, ['a', 'b']),
    /field "b" became required/
  ],
  [
    'request: field removed',
    'request',
    object({ a: text, b: text }, ['a']),
    object({ a: text }, ['a']),
    /field "b" was removed/
  ],
  [
    'request: field removed from an object that does not forbid extras',
    'request',
    { type: 'object', properties: { a: text, b: text }, required: ['a'] },
    { type: 'object', properties: { a: text }, required: ['a'] },
    /field "b" was removed/
  ],
  [
    'request: required field becomes optional',
    'request',
    object({ a: text }, ['a']),
    object({ a: text }),
    undefined
  ],
  [
    'request: optional field becomes required',
    'request',
    object({ a: text }),
    object({ a: text }, ['a']),
    /field "a" became required/
  ],
  [
    'request: enum widened',
    'request',
    object({ m: { enum: ['x'] } }),
    object({ m: { enum: ['x', 'y'] } }),
    undefined
  ],
  [
    'request: enum narrowed',
    'request',
    object({ m: { enum: ['x', 'y'] } }),
    object({ m: { enum: ['x'] } }),
    /"m" no longer accepts "y"/
  ],
  [
    'request: type changed',
    'request',
    object({ a: text }),
    object({ a: { type: 'number' } }),
    /"a" no longer accepts string/
  ],
  [
    'request: integer widened to number',
    'request',
    object({ n: { type: 'integer' } }),
    object({ n: { type: 'number' } }),
    undefined
  ],
  [
    'request: lower bound raised',
    'request',
    object({ n: { type: 'number', minimum: 0 } }),
    object({ n: { type: 'number', minimum: 1 } }),
    /lower bound of "n" increased/
  ],
  [
    'request: default changed',
    'request',
    object({ n: { type: 'number', default: 1 } }),
    object({ n: { type: 'number', default: 2 } }),
    /default of "n" changed/
  ],
  [
    'request: a field named like an annotation changes type',
    'request',
    object({ description: text, title: text }),
    object({ description: { type: 'number' }, title: text }),
    /"description" no longer accepts string/
  ],
  [
    'request: default removed',
    'request',
    object({ n: { type: 'number', default: 1 } }),
    object({ n: { type: 'number' } }),
    /default of "n" was removed/
  ],
  [
    'request: default added',
    'request',
    object({ n: { type: 'number' } }),
    object({ n: { type: 'number', default: 1 } }),
    undefined
  ],
  [
    'request: union widened',
    'request',
    object({ v: { anyOf: [text] } }),
    object({ v: { anyOf: [text, { type: 'number' }] } }),
    undefined
  ],
  [
    'request: union narrowed',
    'request',
    object({ v: { anyOf: [text, { type: 'number' }] } }),
    object({ v: { anyOf: [text] } }),
    /"v" no longer accepts number/
  ],
  [
    'request: a changed keyword this check does not understand',
    'request',
    object({ v: { not: text } }),
    object({ v: { not: { type: 'number' } } }),
    /cannot compare/
  ],
  [
    'response: new optional field',
    'response',
    object({ a: text }, ['a']),
    object({ a: text, b: text }, ['a']),
    undefined
  ],
  [
    'response: new optional field in a strict object',
    'response',
    { ...object({ a: text }, ['a']), 'x-strict': true },
    { ...object({ a: text, b: text }, ['a']), 'x-strict': true },
    /new field "b" is in a strict object/
  ],
  [
    'request: new optional field on an object that does not forbid extras',
    'request',
    { type: 'object', properties: { a: text }, required: ['a'] },
    { type: 'object', properties: { a: text, b: text }, required: ['a'] },
    undefined
  ],
  [
    'request: map entries narrowed',
    'request',
    object({ m: { type: 'object', additionalProperties: text } }),
    object({ m: { type: 'object', additionalProperties: { type: 'number' } } }),
    /no longer accepts string/
  ],
  [
    'request: map of any values narrowed to typed entries',
    'request',
    object({ m: { type: 'object', additionalProperties: {} } }),
    object({ m: { type: 'object', additionalProperties: { type: 'number' } } }),
    /"m.<extra>" is now limited to number/
  ],
  [
    'request: loose object made strict',
    'request',
    { type: 'object', properties: { a: text }, additionalProperties: {} },
    object({ a: text }),
    /the value no longer accepts fields it does not declare/
  ],
  [
    'request: loose object declares a field it took as any value',
    'request',
    { type: 'object', properties: { a: text }, additionalProperties: {} },
    { type: 'object', properties: { a: text, items: text }, additionalProperties: {} },
    /"items" is now limited to string/
  ],
  [
    'response: map entries widened to any value',
    'response',
    object({ m: { type: 'object', additionalProperties: { type: 'number' } } }),
    object({ m: { type: 'object', additionalProperties: {} } }),
    /"m.<extra>" is no longer limited to number/
  ],
  [
    'response: loose object where the old one was not strict',
    'response',
    object({ a: text }),
    { type: 'object', properties: { a: text }, additionalProperties: {} },
    undefined
  ],
  [
    'response: a declared field becomes an untyped entry of a loose object',
    'response',
    object({ a: text, text }),
    { type: 'object', properties: { a: text }, additionalProperties: {} },
    /"text" is no longer limited to string/
  ],
  [
    'response: new field when the old schema allowed extras',
    'response',
    { type: 'object', properties: { a: text }, required: ['a'] },
    { type: 'object', properties: { a: text, b: text }, required: ['a'] },
    undefined
  ],
  [
    'response: required field becomes optional',
    'response',
    object({ a: text }, ['a']),
    object({ a: text }),
    /field "a" is no longer always present/
  ],
  [
    'response: optional field becomes required',
    'response',
    object({ a: text }),
    object({ a: text }, ['a']),
    undefined
  ],
  [
    'response: optional field removed',
    'response',
    object({ a: text, b: text }, ['a']),
    object({ a: text }, ['a']),
    undefined
  ],
  [
    'response: required field removed',
    'response',
    object({ a: text, b: text }, ['a', 'b']),
    object({ a: text }, ['a']),
    /field "b" is no longer always present/
  ],
  [
    'response: enum widened',
    'response',
    object({ m: { enum: ['x'] } }),
    object({ m: { enum: ['x', 'y'] } }),
    /"m" can now be "y"/
  ],
  [
    'response: const widened to its type',
    'response',
    object({ done: { const: true } }),
    object({ done: { type: 'boolean' } }),
    /"done" is no longer limited to fixed values/
  ],
  [
    'response: type widened',
    'response',
    object({ n: { type: 'number' } }),
    object({ n: { type: ['number', 'string'] } }),
    /"n" can now be string/
  ],
  [
    'response: upper bound raised',
    'response',
    object({ n: { type: 'number', maximum: 1 } }),
    object({ n: { type: 'number', maximum: 2 } }),
    /upper bound of "n" increased/
  ],
  [
    'response: enum narrowed',
    'response',
    object({ m: { enum: ['x', 'y'] } }),
    object({ m: { enum: ['x'] } }),
    undefined
  ]
]

for (const [name, direction, before, after, expected] of cases) {
  test(`schema compatibility, ${name}`, function (t) {
    const reason = compare(direction, before, after)
    if (expected === undefined) t.is(reason, undefined, 'compatible')
    else t.ok(expected.test(reason ?? ''), `incompatible: ${reason}`)
  })
}

test('schema compatibility follows $ref on each side to its own definitions', function (t) {
  const before = { $ref: '#/$defs/Item' }
  const after = { $ref: '#/$defs/Item' }
  t.is(
    findIncompatibility(
      before,
      { Item: object({ a: text }) },
      after,
      { Item: object({ a: text, b: text }) },
      {
        direction: 'request'
      }
    ),
    undefined,
    'the new definition adds an optional field'
  )
  t.ok(
    /field "b" became required/.test(
      findIncompatibility(
        before,
        { Item: object({ a: text }) },
        after,
        {
          Item: object({ a: text, b: text }, ['b'])
        },
        { direction: 'request' }
      ) ?? ''
    ),
    'the new definition adds a required field'
  )
})

function snapshot(options: {
  version?: number
  operations?: string[]
  optionalOperations?: string[]
  request?: Schema
  callShape?: string
}): ContractSnapshot {
  const operations = options.operations ?? ['transcribe']
  const optionalOperations = options.optionalOperations ?? ['transcribeStream']
  return {
    capabilities: {
      contracts: [
        {
          id: 'transcription',
          version: options.version ?? 1,
          operations,
          optionalOperations,
          runtimeOperations: []
        }
      ]
    },
    manifest: {
      methods: [...operations, ...optionalOperations].map((name) => ({
        name,
        callShape: name === 'transcribe' ? (options.callShape ?? 'server-stream') : 'duplex',
        requestSchema: `schema.json#/$defs/${name}.request`,
        responseSchema: `schema.json#/$defs/${name}.response`
      }))
    },
    schema: {
      $defs: Object.fromEntries(
        [...operations, ...optionalOperations].flatMap((name) => [
          [
            `${name}.request`,
            name === 'transcribe'
              ? (options.request ?? object({ modelId: text }, ['modelId']))
              : object({})
          ],
          [`${name}.response`, object({ text })]
        ])
      )
    }
  }
}

test('the baseline is the highest stable release at or below the package version', function (t) {
  const published = ['0.11.0', '0.11.1', '0.12.0', '0.13.0-rc.1']
  t.is(baselineVersion(published, '0.11.2'), '0.11.1', 'a patch on an older line')
  t.is(baselineVersion(published, '0.13.0'), '0.12.0', 'the next release')
  t.is(baselineVersion(published, '0.10.0'), undefined, 'nothing published at or below')
})

test('an unchanged contract has no problems', function (t) {
  t.alike(findMajorProblems(snapshot({}), snapshot({})), [])
})

test('an incompatible request change needs a major bump', function (t) {
  const breaking = { request: object({ modelId: text, language: text }, ['modelId', 'language']) }
  t.alike(findMajorProblems(snapshot({}), snapshot(breaking)), [
    'transcription@1: transcribe request: field "language" became required'
  ])
  t.alike(findMajorProblems(snapshot({}), snapshot({ ...breaking, version: 2 })), [], 'bumped to 2')
})

test('a compatible request change keeps the major', function (t) {
  t.alike(
    findMajorProblems(
      snapshot({}),
      snapshot({ request: object({ modelId: text, language: text }, ['modelId']) })
    ),
    []
  )
})

test('operation changes under the same major are reported', function (t) {
  t.alike(findMajorProblems(snapshot({}), snapshot({ optionalOperations: [] })), [
    'transcription@1: optional operation transcribeStream was removed'
  ])
  t.alike(
    findMajorProblems(
      snapshot({}),
      snapshot({ operations: ['transcribe', 'transcribeStream'], optionalOperations: [] })
    ),
    ['transcription@1: optional operation transcribeStream became required']
  )
  t.alike(findMajorProblems(snapshot({}), snapshot({ callShape: 'request-reply' })), [
    'transcription@1: transcribe changed from server-stream to request-reply'
  ])
})

test('an operation without recorded schemas is reported', function (t) {
  const unrecorded = snapshot({})
  unrecorded.manifest.methods = unrecorded.manifest.methods.filter(
    (method) => method.name !== 'transcribe'
  )
  t.alike(findMajorProblems(snapshot({}), unrecorded), [
    'transcription@1: transcribe has no recorded schemas in the working tree'
  ])
  t.alike(findMajorProblems(unrecorded, snapshot({})), [
    'transcription@1: transcribe has no recorded schemas in the published baseline'
  ])
})

test('a published contract that disappears without a higher major is reported', function (t) {
  const gone: ContractSnapshot = { ...snapshot({}), capabilities: { contracts: [] } }
  t.alike(findMajorProblems(snapshot({}), gone), [
    'transcription@1 was published and is no longer defined'
  ])
})

// A fresh copy each time, so a test can change it without touching the others.
function baseline(): ContractSnapshot {
  return JSON.parse(JSON.stringify(buildCapabilityBaseline())) as ContractSnapshot
}

function defOf(snapshot: ContractSnapshot, name: string): Schema {
  return snapshot.schema.$defs[name] as Schema
}

test('the capability baseline is compatible with itself', function (t) {
  const current = baseline()
  t.ok(current.capabilities.contracts.length > 0, 'it lists the contracts')
  t.ok(
    current.manifest.methods.some((method) => method.name === 'transcribe'),
    'it carries the typed operations'
  )
  t.alike(findMajorProblems(current, baseline()), [])
})

test('the capability baseline records every contract operation', function (t) {
  const current = baseline()
  const recorded = new Set(current.manifest.methods.map((method) => method.name))
  const missing = current.capabilities.contracts
    .flatMap((contract) => [...contract.operations, ...contract.optionalOperations])
    .filter((operation) => !recorded.has(operation))
  t.alike(missing, [], 'operations called through pluginInvoke included')

  const changed = baseline()
  const vlaRequest = defOf(changed, 'vlaRun.request')
  vlaRequest['required'] = [...(vlaRequest['required'] as string[]), 'noise']
  t.alike(findMajorProblems(baseline(), changed), [
    'vision-language-action@1: vlaRun request: field "noise" became required'
  ])
})

test('the capability baseline compares completionOrchestrate under completion', function (t) {
  const current = baseline()
  const completion = current.capabilities.contracts.find((contract) => contract.id === 'completion')
  t.alike(completion?.runtimeOperations, ['completionOrchestrate'])

  const changed = baseline()
  const orchestrate = defOf(changed, 'completionOrchestrate.request')
  orchestrate['properties'] = { ...(orchestrate['properties'] as Schema), turnLimit: text }
  orchestrate['required'] = [
    ...((orchestrate['required'] as string[] | undefined) ?? []),
    'turnLimit'
  ]
  t.alike(findMajorProblems(baseline(), changed), [
    'completion@1: completionOrchestrate request: field "turnLimit" became required'
  ])

  const input = baseline()
  const toolResult = defOf(input, 'completionOrchestrate.input')
  toolResult['required'] = [...(toolResult['required'] as string[]), 'error']
  t.alike(findMajorProblems(baseline(), input), [
    'completion@1: completionOrchestrate input: field "error" became required'
  ])

  const removed = baseline()
  for (const contract of removed.capabilities.contracts) contract.runtimeOperations = []
  t.alike(findMajorProblems(baseline(), removed), [
    'completion@1: runtime operation completionOrchestrate was removed'
  ])
})

test('the capability baseline marks strict Zod objects only', function (t) {
  const current = baseline()
  t.is(defOf(current, 'completionStream.response')['x-strict'], true, 'completionStream is strict')
  t.is(defOf(current, 'transcribe.response')['x-strict'], undefined, 'transcribe is not')
})

test('real schema changes are judged by the field rules', function (t) {
  const plain = baseline()
  const plainResponse = defOf(plain, 'transcribe.response')
  plainResponse['properties'] = { ...(plainResponse['properties'] as Schema), language: text }
  t.alike(findMajorProblems(baseline(), plain), [], 'a new transcribe response field')

  const strict = baseline()
  const strictResponse = defOf(strict, 'completionStream.response')
  strictResponse['properties'] = { ...(strictResponse['properties'] as Schema), language: text }
  t.alike(
    findMajorProblems(baseline(), strict),
    [
      'completion@1: completionStream response: new field "language" is in a strict object, which clients reject unknown fields in'
    ],
    'a new completionStream response field'
  )

  const request = baseline()
  const transcribeRequest = defOf(request, 'transcribe.request')
  transcribeRequest['properties'] = {
    ...(transcribeRequest['properties'] as Schema),
    language: text
  }
  transcribeRequest['required'] = [...(transcribeRequest['required'] as string[]), 'language']
  t.alike(
    findMajorProblems(baseline(), request),
    ['transcription@1: transcribe request: field "language" became required'],
    'a new required transcribe request field'
  )
})
