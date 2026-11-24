import test from 'brittle'
import { createCompletionNormalizer } from '@/utils/completion-normalizer'
import { buildFinalFromEvents } from '@/utils/aggregate-events'
import { parseToolCalls } from '@/utils/tools/index'
import { repairToolArguments } from '@/utils/tools/repair'
import type { CompletionEvent, Tool, ToolDialect } from '@/schemas'

const LOGIN: Tool = {
  type: 'function',
  name: 'login',
  description: 'log in',
  parameters: {
    type: 'object',
    properties: {
      password: { type: 'string' },
      note: { type: 'string' }
    }
  }
}

const HTTP: Tool = {
  type: 'function',
  name: 'http_request',
  description: 'send a request',
  parameters: {
    type: 'object',
    properties: {
      url: { type: 'string' },
      method: { type: 'string', enum: ['GET', 'POST'] },
      headers: { type: 'object' },
      body: { type: 'object' }
    },
    required: ['url']
  }
}

type Run = {
  calls: { id: string; name: string; arguments: Record<string, unknown> }[]
  finalCalls: { id: string; name: string; arguments: Record<string, unknown> }[]
  content: string
  thinking: string
  errors: number
}

// What the llama.cpp plugin does: stream tokens through the normalizer, then
// hand it the calls a parse of the whole reply found, then aggregate.
function run(tokens: string[], tools: Tool[], dialect: ToolDialect = 'qwen35'): Run {
  const n = createCompletionNormalizer({
    capabilities: { toolCalling: 'textParse', thinkingFraming: 'thinkTags' },
    tools,
    captureThinking: true,
    emitRawDeltas: false,
    toolDialect: dialect
  })
  const events: CompletionEvent[] = []
  for (const token of tokens) events.push(...n.push(token))
  const { toolCalls } = parseToolCalls(tokens.join(''), tools, dialect)
  events.push(...n.finish({ toolCalls, stopReason: 'eos' }))
  const { final } = buildFinalFromEvents(events, new Map())
  return {
    calls: events.flatMap((e) => (e.type === 'toolCall' ? [e.call] : [])),
    finalCalls: final.toolCalls,
    content: final.contentText,
    thinking: final.thinkingText ?? '',
    errors: events.filter((e) => e.type === 'toolError').length
  }
}

function chunks(text: string, size: number): string[] {
  return text.match(new RegExp(`[\\s\\S]{1,${size}}`, 'g')) ?? []
}

function argsOf(r: Run) {
  return r.calls.map((c) => [c.name, c.arguments])
}

type Shape = {
  label: string
  text: string
  expected: [string, Record<string, unknown>][]
  dialects?: readonly ToolDialect[]
}

const recovered: Shape[] = [
  {
    label: 'bare call without a <tool_call> wrapper',
    text: '<function=login><parameter=password>p1</parameter></function>',
    expected: [['login', { password: 'p1' }]]
  },
  {
    label: 'whitespace before the closing angle bracket',
    text: '<function=login ><parameter=password >p2</parameter></function>',
    expected: [['login', { password: 'p2' }]]
  },
  {
    label: 'function opener inside a parameter value',
    text: '<function=login><parameter=password>p3</parameter><parameter=note>see <function=x> here</parameter></function>',
    expected: [['login', { password: 'p3', note: 'see <function=x> here' }]]
  },
  {
    label: 'an early closer ends the call',
    text: 'Logging in.\n<function=login></function>',
    expected: [['login', {}]]
  },
  {
    label: 'two calls in a row',
    text: '<function=login><parameter=password>a</parameter></function>\n<function=login><parameter=password>b</parameter></function>',
    expected: [
      ['login', { password: 'a' }],
      ['login', { password: 'b' }]
    ]
  },
  {
    label: 'wrapped call in the hermes dialect frame',
    text: '<tool_call>\n<function=login>\n<parameter=password>\np4\n</parameter>\n</function>\n</tool_call>',
    expected: [['login', { password: 'p4' }]]
  }
]

test('recoverable markup yields one call per block with the same id streamed and final', (t) => {
  for (const shape of recovered) {
    for (const size of [1, 7, shape.text.length]) {
      for (const dialect of ['qwen35', 'hermes'] as const) {
        const r = run(chunks(shape.text, size), [LOGIN], dialect)
        const where = `${shape.label} (${dialect}, ${size}-char tokens)`
        t.alike(argsOf(r), shape.expected, `${where}: calls`)
        t.alike(r.finalCalls, r.calls, `${where}: final matches streamed, ids included`)
        t.absent(r.content.includes('<function'), `${where}: markup is not visible`)
        t.is(r.errors, 0, `${where}: no tool error`)
      }
    }
  }
})

const notCalls: Shape[] = [
  {
    label: 'unknown tool',
    text: '<function=rm><parameter=path>/</parameter></function>',
    expected: []
  },
  {
    label: 'a wrapper around another call is ambiguous',
    text: '<function=login><function=login><parameter=password>x</parameter></function>',
    expected: []
  },
  {
    label: 'truncated before the closer',
    text: '<function=login><parameter=password>trunc',
    expected: []
  },
  {
    label: 'upper-case tags are not the bare dialect',
    text: '<FUNCTION=login><PARAMETER=password>x</PARAMETER></FUNCTION>',
    expected: []
  },
  {
    label: 'a call followed by more prose is an example',
    text: 'Call it like <function=login><parameter=password>x</parameter></function> and wait.',
    expected: []
  },
  {
    label: 'a wrapped call followed by more prose is an example',
    text: 'For example <tool_call>{"name":"login","arguments":{"password":"x"}}</tool_call> works.',
    expected: [],
    dialects: ['qwen35']
  },
  {
    label: 'a call only quoted inside reasoning',
    text: '<think>I could send <function=login><parameter=password>x</parameter></function> but no.</think>Not now.',
    expected: []
  }
]

test('unknown, ambiguous, truncated and quoted markup does not become a call', (t) => {
  for (const shape of notCalls) {
    for (const size of [1, 5, shape.text.length]) {
      for (const dialect of shape.dialects ?? (['qwen35', 'hermes'] as const)) {
        const r = run(chunks(shape.text, size), [LOGIN], dialect)
        const where = `${shape.label} (${dialect}, ${size}-char tokens)`
        t.alike(r.calls, [], `${where}: no streamed call`)
        t.alike(r.finalCalls, [], `${where}: no final call`)
      }
    }
  }
})

const prose = [
  'Close with </function>.',
  'Close with </FUNCTION>.',
  'Use the <parameter=name> tag in the example.',
  'The model may print <FUNCTION=x> while explaining the format.',
  'Write <function = x> literally in documentation.',
  'An empty opener <function= > is only text.',
  'A list <function=a b> is not a name.'
]

test('markup-like prose is shown unchanged and never executes, at every split', (t) => {
  for (const text of prose) {
    for (let split = 0; split <= text.length; split++) {
      const r = run([text.slice(0, split), text.slice(split)], [LOGIN])
      t.is(r.content, text, `${text}: split ${split}`)
      t.is(r.calls.length, 0, `${text}: split ${split} makes no call`)
      t.is(r.errors, 0, `${text}: split ${split} raises no tool error`)
    }
  }
})

test('a bare call is recovered and hidden at every split', (t) => {
  const text = 'Sure.\n<function=login><parameter=password>s</parameter></function>'
  for (let split = 0; split <= text.length; split++) {
    const r = run([text.slice(0, split), text.slice(split)], [LOGIN])
    t.is(r.content, 'Sure.\n', `split ${split}: content`)
    t.alike(argsOf(r), [['login', { password: 's' }]], `split ${split}: call`)
  }
})

test('adjacent blocks followed by prose are all examples, at every split', (t) => {
  const block = (p: string) => `<function=login><parameter=password>${p}</parameter></function>`
  const text = `${block('a')}\n${block('b')}\nThese are examples, not requests.`
  for (let split = 0; split <= text.length; split++) {
    const r = run([text.slice(0, split), text.slice(split)], [LOGIN])
    t.is(r.content, text, `split ${split}: shown as text`)
    t.is(r.calls.length + r.finalCalls.length, 0, `split ${split}: no call`)
  }
})

test('adjacent blocks at the end of the turn are all made, in order', (t) => {
  const block = (p: string) => `<function=login><parameter=password>${p}</parameter></function>`
  const text = `${block('a')}\n${block('b')}\n`
  for (let split = 0; split <= text.length; split++) {
    const r = run([text.slice(0, split), text.slice(split)], [LOGIN])
    t.alike(argsOf(r), [
      ['login', { password: 'a' }],
      ['login', { password: 'b' }]
    ])
    t.is(r.content, '', `split ${split}: markup hidden`)
  }
})

test('a role marker split across pushes does not demote the calls before it', (t) => {
  const weather: Tool = {
    type: 'function',
    name: 'get_weather',
    description: 'weather',
    parameters: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] }
  }
  const call = (city: string) =>
    `<|channel|>commentary to=functions.get_weather <|constrain|>json<|message|>{"city":"${city}"}<|call|>`
  const text = `${call('Tokyo')}<|start|>assistant${call('Lima')}`
  for (let split = 0; split <= text.length; split++) {
    const r = run([text.slice(0, split), text.slice(split)], [weather], 'harmony')
    t.alike(
      argsOf(r),
      [
        ['get_weather', { city: 'Tokyo' }],
        ['get_weather', { city: 'Lima' }]
      ],
      `split ${split}`
    )
    t.is(r.content, '', `split ${split}: no visible text`)
  }
})

test('an unfinished tag after a call at the end of the turn is shown and makes it an example', (t) => {
  const block = '<function=login><parameter=password>a</parameter></function>'
  const r = run([block, ' <note'], [LOGIN])
  t.is(r.content, `${block} <note`)
  t.is(r.calls.length + r.finalCalls.length, 0)

  const glue = run([block, '<|im_end'], [LOGIN])
  t.alike(argsOf(glue), [['login', { password: 'a' }]], 'a cut-off special token is markup')
  t.is(glue.content, '')
})

test('a call cut off after a complete one keeps the complete one made', (t) => {
  const block = '<function=login><parameter=password>a</parameter></function>'
  const cut = '<function=login><parameter=password>trunc'
  const text = `${block}\n${cut}`
  for (let split = 0; split <= text.length; split++) {
    const r = run([text.slice(0, split), text.slice(split)], [LOGIN])
    t.alike(argsOf(r), [['login', { password: 'a' }]], `split ${split}: call`)
    t.is(r.content, cut, `split ${split}: cut-off block shown`)
  }

  const prose = run([block, '\n<function=unknown> is how it looks'], [LOGIN])
  t.is(prose.calls.length + prose.finalCalls.length, 0, 'an undeclared name is still prose')
})

test('where the template does not end the turn at a call, text after it keeps the call', (t) => {
  const status: Tool = {
    type: 'function',
    name: 'get_candidate_status',
    description: 'status',
    parameters: {
      type: 'object',
      properties: { candidate_id: { type: 'string' } },
      required: ['candidate_id']
    }
  }
  const lfm2 =
    '<|tool_call_start|>[get_candidate_status(candidate_id="12345")]<|tool_call_end|>' +
    'Checking the current status of candidate ID 12345.'
  for (let split = 0; split <= lfm2.length; split++) {
    const r = run([lfm2.slice(0, split), lfm2.slice(split)], [status], 'pythonic')
    t.alike(argsOf(r), [['get_candidate_status', { candidate_id: '12345' }]], `split ${split}`)
    t.is(r.content, 'Checking the current status of candidate ID 12345.', `split ${split}`)
  }

  const call = (p: string) =>
    `<tool_call>{"name":"login","arguments":{"password":"${p}"}}</tool_call>`
  const hermes = run(
    chunks(`First Paris. ${call('a')} And Rome. ${call('b')} Done.`, 5),
    [LOGIN],
    'hermes'
  )
  t.alike(argsOf(hermes), [
    ['login', { password: 'a' }],
    ['login', { password: 'b' }]
  ])
  t.is(hermes.content, 'First Paris.  And Rome.  Done.')
})

test('a <function=NAME> in prose does not hold back the text after it', (t) => {
  for (const name of ['name', 'login']) {
    const text = `Qwen writes calls as <function=${name}> blocks, then closes them. More prose follows.`
    const n = createCompletionNormalizer({
      capabilities: { toolCalling: 'textParse', thinkingFraming: 'thinkTags' },
      tools: [LOGIN],
      captureThinking: true,
      emitRawDeltas: false,
      toolDialect: 'qwen35'
    })
    const streamed = chunks(text, 3)
      .flatMap((c) => n.push(c))
      .flatMap((e) => (e.type === 'contentDelta' ? [e.text] : []))
      .join('')
    t.is(streamed, text.slice(0, streamed.length), `${name}: streamed in order`)
    t.ok(
      streamed.length >= text.length - 3,
      `${name}: ${streamed.length} of ${text.length} streamed`
    )
  }
})

test('OpenAI-style string arguments are read as an object', (t) => {
  const frame = `<tool_call>{"name":"login","arguments":${JSON.stringify(JSON.stringify({ password: 's' }))}}</tool_call>`
  for (const dialect of ['hermes', 'qwen35'] as const) {
    const r = run(chunks(frame, 9), [LOGIN], dialect)
    t.alike(argsOf(r), [['login', { password: 's' }]], dialect)
    t.is(r.errors, 0, dialect)
  }
  const bareJson = parseToolCalls(
    JSON.stringify({ name: 'login', arguments: '{"password":"s"}' }),
    [LOGIN],
    'json'
  )
  t.alike(
    bareJson.toolCalls.map((c) => c.arguments),
    [{ password: 's' }]
  )
})

test('an optional non-null qwen35 parameter written as null is left out', (t) => {
  const search: Tool = {
    type: 'function',
    name: 'search',
    description: 'search',
    parameters: {
      type: 'object',
      properties: { query: { type: 'string' }, limit: { type: 'integer' } },
      required: ['query']
    }
  }
  const r = run(
    [
      '<tool_call>\n<function=search>\n<parameter=query>cats</parameter>\n<parameter=limit>null</parameter>\n</function>\n</tool_call>'
    ],
    [search]
  )
  t.alike(argsOf(r), [['search', { query: 'cats' }]])
  t.is(r.errors, 0)
})

test('repaired arguments are the same in the stream and the final result', (t) => {
  const text =
    '<tool_call>\n<function=http_request>\n<parameter=url>https://x.test</parameter>\n' +
    '<parameter=method>post</parameter>\n<parameter=body>{"text":"line one\nline two"</parameter>\n' +
    '</function>\n</tool_call>'
  const r = run(chunks(text, 4), [HTTP])
  t.alike(argsOf(r), [
    [
      'http_request',
      { url: 'https://x.test', method: 'POST', body: { text: 'line one\nline two' } }
    ]
  ])
  t.alike(r.finalCalls, r.calls)
})

test('hermes JSON arguments are repaired against the schema', (t) => {
  const call = {
    name: 'http_request',
    arguments: { url: 'https://x.test', body: '{"title":"Doc"}', method: 'get' }
  }
  const r = run([`<tool_call>${JSON.stringify(call)}</tool_call>`], [HTTP], 'hermes')
  t.alike(argsOf(r), [
    ['http_request', { url: 'https://x.test', body: { title: 'Doc' }, method: 'GET' }]
  ])
})

test('arguments nested under an undeclared wrapper key are unwrapped', (t) => {
  const call = { name: 'http_request', arguments: { arguments: { url: 'https://x.test' } } }
  const r = run([`<tool_call>${JSON.stringify(call)}</tool_call>`], [HTTP], 'hermes')
  t.alike(argsOf(r), [['http_request', { url: 'https://x.test' }]])
})

test('arguments the schema already accepts are not unwrapped', (t) => {
  const open = { type: 'object', properties: {}, additionalProperties: { type: 'string' } }
  const args = { input: '{"name":"demo"}' }
  t.is(repairToolArguments(args, open), args, 'undeclared keys allowed')

  const strict = HTTP.parameters
  const unknown = { input: { name: 'demo' } }
  t.is(repairToolArguments(unknown, strict), unknown, 'inner keys the tool does not declare')

  const patterned = {
    type: 'object',
    properties: { url: { type: 'string' } },
    required: ['url'],
    additionalProperties: false,
    patternProperties: { '^x-': { type: 'string' } }
  }
  t.alike(
    repairToolArguments({ arguments: { url: 'https://x.test' } }, patterned),
    { url: 'https://x.test' },
    'a pattern that does not match the wrapper key'
  )
  const matching = { ...patterned, patternProperties: { '^arg': { type: 'object' } } }
  const kept = { arguments: { url: 'https://x.test' } }
  t.is(repairToolArguments(kept, matching), kept, 'a pattern that matches the wrapper key')
})

// Cases from the app harness's argument-repair suite, minus its app-specific
// shell escaping.
const HTTP_PARAMETERS = HTTP.parameters

function body(value: string) {
  return repairToolArguments({ url: 'u', body: value }, HTTP_PARAMETERS)['body']
}

test('a structured parameter written as text is decoded', (t) => {
  t.alike(body('{"title":"My Document"}'), { title: 'My Document' })
  t.alike(body('{"requests":[{"text":"line one\n\nline two"}]}'), {
    requests: [{ text: 'line one\n\nline two' }]
  })
  t.alike(body('{"requests":[{"insertText":{"text":"hi"}}]'), {
    requests: [{ insertText: { text: 'hi' } }]
  })
  t.alike(body('{"requests":[{"insertText":{"text":"hi'), {
    requests: [{ insertText: { text: 'hi' } }]
  })
  t.alike(body('{\n  "title": "My Document",\n  "meta": {\n    "n": 1\n  }\n}'), {
    title: 'My Document',
    meta: { n: 1 }
  })
  t.alike(body('```json\n{"title":"My Document"}\n```'), { title: 'My Document' })
  t.alike(body(JSON.stringify('{"title":"x"}')), { title: 'x' })
  t.alike(body('"requests":[{"text":"hi"}]'), { requests: [{ text: 'hi' }] })
  t.alike(body('{"requests":[{"text":"hi"}]}\nThat should do it.'), { requests: [{ text: 'hi' }] })
  t.alike(body('{"text":"USDT is the "digital dollar"."}'), {
    text: 'USDT is the "digital dollar".'
  })
  t.alike(body('{"requests":[{"text":"Tibia",}],}'), { requests: [{ text: 'Tibia' }] })
  t.alike(body("{'title':'My Document'}"), { title: 'My Document' })
  t.alike(body('{"bold":True,"italic":False,"link":None}'), {
    bold: true,
    italic: false,
    link: null
  })
})

test('a valid array is not read as an object followed by prose', (t) => {
  const tool: Tool = {
    type: 'function',
    name: 'store',
    description: 'store',
    parameters: {
      type: 'object',
      properties: { items: { type: ['object', 'array'] } },
      required: ['items']
    }
  }
  const text =
    '<tool_call>\n<function=store>\n<parameter=items>\n[{"id":1},"keep"]\n</parameter>\n</function>\n</tool_call>'
  const r = run([text], [tool])
  t.alike(argsOf(r), [['store', { items: [{ id: 1 }, 'keep'] }]])

  const prose = run([text.replace('[{"id":1},"keep"]', '{"id":1}\nthat is the item')], [tool])
  t.alike(argsOf(prose), [['store', { items: { id: 1 } }]], 'an object followed by prose')
})

test('text that does not hold the declared structure is left alone', (t) => {
  t.is(body('[{"title":"My Document"}]'), '[{"title":"My Document"}]')
  t.is(body('{bad json'), '{bad json')
  t.is(body('just words'), 'just words')
})

test('a string parameter keeps its value whatever it looks like', (t) => {
  const args = repairToolArguments({ url: '{"not":"a body"}' }, HTTP_PARAMETERS)
  t.is(args['url'], '{"not":"a body"}')
  const either = repairToolArguments(
    { v: '{"a":1}' },
    { type: 'object', properties: { v: { type: ['string', 'object'] } } }
  )
  t.is(either['v'], '{"a":1}')
})

function coerced(value: unknown, property: Record<string, unknown>) {
  return repairToolArguments({ value }, { type: 'object', properties: { value: property } })[
    'value'
  ]
}

test('scalars written as strings are coerced only when lossless', (t) => {
  t.is(coerced('3', { type: 'integer' }), 3)
  t.is(coerced(' -2 ', { type: 'integer' }), -2)
  t.is(coerced('-2.5', { type: 'number' }), -2.5)
  t.is(coerced('3.0', { type: 'integer' }), 3)
  t.is(coerced('True', { type: 'boolean' }), true)
  t.is(coerced('false', { type: 'boolean' }), false)
  t.is(coerced('null', { type: ['integer', 'null'] }), null)
  t.is(coerced('4', { oneOf: [{ type: 'integer' }, { type: 'object' }] }), 4)

  t.is(coerced('3.5', { type: 'integer' }), '3.5')
  t.is(coerced('007', { type: 'integer' }), '007')
  t.is(coerced('12345678901234567890', { type: 'integer' }), '12345678901234567890')
  t.is(coerced('1e400', { type: 'number' }), '1e400')
  t.is(coerced('1e-400', { type: 'number' }), '1e-400')
  t.is(coerced('0x10', { type: 'number' }), '0x10')
  t.is(coerced('', { type: 'integer' }), '')
  t.is(coerced('yes', { type: 'boolean' }), 'yes')
  t.is(coerced('1', { type: 'boolean' }), '1')
  t.is(coerced('3', { type: ['string', 'integer'] }), '3')
  t.is(coerced('true', { oneOf: [{ type: 'string' }, { type: 'boolean' }] }), 'true')
})

test('a string an enum-only branch accepts is never changed or dropped', (t) => {
  const props = { limit: { anyOf: [{ type: 'integer' }, { enum: ['null', 'auto', '3'] }] } }
  const schema = { type: 'object', properties: props }
  for (const value of ['null', 'auto', '3']) {
    t.alike(repairToolArguments({ limit: value }, schema), { limit: value }, value)
  }
  const constant = {
    type: 'object',
    properties: { n: { anyOf: [{ type: 'number' }, { const: '7' }] } }
  }
  t.alike(repairToolArguments({ n: '7' }, constant), { n: '7' }, 'const')
})

test('enum casing is folded only when exactly one value matches', (t) => {
  t.is(coerced('post', { type: 'string', enum: ['GET', 'POST'] }), 'POST')
  t.is(coerced('ab', { type: 'string', enum: ['aB', 'AB'] }), 'ab')
  t.is(coerced('PATCH', { type: 'string', enum: ['GET', 'POST'] }), 'PATCH')
})

test('"null" drops an optional non-null field and stays for a required one', (t) => {
  const schema = {
    type: 'object',
    properties: { name: { type: 'string' }, limit: { type: 'integer' } },
    required: ['name']
  }
  t.alike(repairToolArguments({ name: 'a', limit: 'null' }, schema), { name: 'a' })
  t.alike(repairToolArguments({ limit: 'null' }, { ...schema, required: ['limit'] }), {
    limit: 'null'
  })
})

test('nested values are repaired through items and properties', (t) => {
  const files = {
    type: 'array',
    items: {
      type: 'object',
      properties: { path: { type: 'string' }, startLine: { type: 'number' } }
    }
  }
  t.alike(coerced([{ path: 'a.txt', startLine: '2' }], files), [{ path: 'a.txt', startLine: 2 }])
  t.alike(coerced('[{"op":"add","path":"/a"}]', { type: 'array', items: { type: 'object' } }), [
    { op: 'add', path: '/a' }
  ])
  t.alike(
    coerced('{"count":"4","note":"5"}', {
      type: 'object',
      properties: { count: { type: 'integer' } }
    }),
    { count: 4, note: '5' }
  )
})

test('an unchanged call keeps its arguments object', (t) => {
  const args = { url: 'u' }
  t.is(repairToolArguments(args, HTTP_PARAMETERS), args)
})

// A quadratic scan of 1 MB takes minutes; a shared CI runner needs seconds for a linear one.
const BUDGET_MS = 10_000

test('adversarial bare markup stays linear at one megabyte', (t) => {
  const openers = '<function=x>'.repeat(Math.ceil((1024 * 1024) / 12))
  for (const text of [openers, `${openers}</function>`, '</function> '.repeat(90_000)]) {
    const started = Date.now()
    const r = run(chunks(text, 4096), [LOGIN])
    const elapsed = Date.now() - started
    t.is(r.calls.length, 0)
    t.ok(elapsed < BUDGET_MS, `${text.length} chars in ${elapsed}ms`)
  }
})

test('repairing an object with many keys stays linear', (t) => {
  const keys = Array.from({ length: 50_000 }, (_, i) => `"k${i}": ${i}`).join(', ')
  const started = Date.now()
  const r = repairToolArguments(
    { payload: `{${keys},}` },
    { type: 'object', properties: { payload: { type: 'object' } } }
  )
  const elapsed = Date.now() - started
  t.is(Object.keys(r.payload as object).length, 50_000)
  t.ok(elapsed < BUDGET_MS, `${keys.length} chars in ${elapsed}ms`)
})

test('a string value full of escaped quotes stays linear to scan', (t) => {
  const value = '\\"'.repeat(256 * 1024)
  const started = Date.now()
  const r = repairToolArguments(
    { payload: `{"a": "${value}", "b": 1,}` },
    { type: 'object', properties: { payload: { type: 'object' } } }
  )
  const elapsed = Date.now() - started
  t.is((r.payload as { b: number }).b, 1)
  t.ok(elapsed < BUDGET_MS, `${value.length} chars in ${elapsed}ms`)
})

test('whitespace after a bare opener is not held without limit', (t) => {
  const text = `<function=login>${' \n'.repeat(512 * 1024)}`
  const started = Date.now()
  const r = run(chunks(text, 16), [LOGIN])
  const elapsed = Date.now() - started
  t.is(r.calls.length, 0)
  t.is(r.content, text)
  t.ok(elapsed < BUDGET_MS, `${text.length} chars in ${elapsed}ms`)

  const spaced = `<function=login>\n\n<parameter=password>s</parameter>\n</function>`
  t.alike(
    argsOf(run(chunks(spaced, 3), [LOGIN])),
    [['login', { password: 's' }]],
    'a short gap is a call'
  )
})

test('whitespace after a held call is consumed as it arrives', (t) => {
  const block = '<function=login><parameter=password>a</parameter></function>'
  const pad = ' \n'.repeat(512 * 1024)
  const started = Date.now()
  const made = run([block, ...chunks(pad, 16)], [LOGIN])
  const elapsed = Date.now() - started
  t.alike(argsOf(made), [['login', { password: 'a' }]])
  t.is(made.content, '')
  t.ok(elapsed < BUDGET_MS, `${pad.length} chars in ${elapsed}ms`)

  const example = run([block, ...chunks(' \n'.repeat(8), 3), 'and prose'], [LOGIN])
  t.is(example.content, `${block}${' \n'.repeat(8)}and prose`, 'whitespace kept in order')
  t.is(example.calls.length + example.finalCalls.length, 0)
})
