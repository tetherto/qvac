'use strict'

/**
 * Unit tests for scripts/ci/verify-openclaw-agent-output.cjs.
 *
 * Fixtures are real `openclaw agent --json` payloads from scheduled smoke
 * runs, pruned only of the bulky system-prompt report, and mutations below are
 * applied at real field paths. Both matter: the bug these guard against was
 * reading paths that do not exist, which a hand-authored fixture would repeat.
 *
 * Run locally:
 *   node --test scripts/ci/__tests__/verify-openclaw-agent-output.test.cjs
 */

const test = require('node:test')
const assert = require('node:assert/strict')
const { readFileSync } = require('node:fs')
const { join } = require('node:path')

const { verifyAgentOutput } = require('../verify-openclaw-agent-output.cjs')

const MODEL = 'qwen3.5-0.8b'
const FIXTURES = join(__dirname, 'fixtures')

function fixture (name) {
  return readFileSync(join(FIXTURES, `${name}.json`), 'utf8')
}

function mutated (name, mutate) {
  const parsed = JSON.parse(fixture(name))
  mutate(parsed)
  return JSON.stringify(parsed)
}

function assertRejects (text, expected) {
  assert.throws(() => verifyAgentOutput(text, MODEL), expected)
}

test('accepts a genuine qvac-ok reply', () => {
  verifyAgentOutput(fixture('pass-qvac-ok'), MODEL)
})

test('accepts a reply prefixed with an OpenClaw routing token', () => {
  verifyAgentOutput(
    mutated('pass-qvac-ok', (d) => {
      d.meta.finalAssistantVisibleText = '[[reply_to:abc123]]qvac-ok'
    }),
    MODEL
  )
})

// The regression that motivated this file: a refusal quoting the token back,
// reported green at the time.
test('rejects a refusal that quotes qvac-ok back', () => {
  assertRejects(fixture('refusal-quoting-token'), /did not answer with qvac-ok/)
})

test('rejects a bare routing token with no content behind it', () => {
  assertRejects(fixture('routing-token-only'), /replied with no content/)
})

test('rejects a reply that ignores the instruction', () => {
  assertRejects(fixture('unrelated-reply'), /did not answer with qvac-ok/)
})

test('rejects empty stdout', () => {
  assertRejects('', /produced no stdout/)
})

test('rejects stdout that is not JSON', () => {
  assertRejects('not json at all', /did not contain JSON output/)
})

test('rejects an empty assistant text', () => {
  assertRejects(
    mutated('pass-qvac-ok', (d) => {
      d.meta.finalAssistantVisibleText = ''
      d.payloads = [{ text: '', mediaUrl: null }]
    }),
    /produced no assistant text/
  )
})

test('rejects an aborted run', () => {
  assertRejects(
    mutated('pass-qvac-ok', (d) => {
      d.meta.aborted = true
    }),
    /run was aborted/
  )
})

// fallbackUsed lives at meta.executionTrace.fallbackUsed. Reading meta.fallbackUsed
// left this assertion undefined and therefore skipped.
test('rejects a run that fell back to another model', () => {
  assertRejects(
    mutated('pass-qvac-ok', (d) => {
      d.meta.executionTrace.fallbackUsed = 'qvac/qwen3.5-2b'
    }),
    /fallback was used: qvac\/qwen3\.5-2b/
  )
})

test('rejects a wrong provider', () => {
  assertRejects(
    mutated('pass-qvac-ok', (d) => {
      d.meta.agentMeta.provider = 'openai'
    }),
    /did not run through the qvac provider: openai/
  )
})

test('rejects a wrong model', () => {
  assertRejects(
    mutated('pass-qvac-ok', (d) => {
      d.meta.agentMeta.model = 'gpt-oss-20b'
    }),
    /ran model gpt-oss-20b, expected qwen3\.5-0\.8b/
  )
})

test('accepts the model id with a qvac\/ prefix', () => {
  verifyAgentOutput(
    mutated('pass-qvac-ok', (d) => {
      d.meta.agentMeta.model = `qvac/${MODEL}`
    }),
    MODEL
  )
})

// The old verifier fell through to a JSON.stringify of the payload, which
// always contains the echoed prompt.
test('does not satisfy the content check from the echoed prompt alone', () => {
  const text = mutated('pass-qvac-ok', (d) => {
    d.meta.finalAssistantVisibleText = 'Hello.'
    d.payloads = [{ text: 'Hello.', mediaUrl: null }]
  })
  assert.match(text, /qvac-ok/, 'fixture must still echo the prompt in meta.finalPromptText')
  assertRejects(text, /did not answer with qvac-ok/)
})

// Reported the smoke as passed (run 34375067376): mentions the token, answers
// nothing, and short enough that the old length cap never caught it.
test('rejects a short non-answer that mentions the token', () => {
  assertRejects(fixture('short-non-answer-quoting-token'), /did not answer with qvac-ok/)
})

// Reported `main`'s smoke as passing (run 34324684069): tool-call *parameter*
// markup instead of an answer. A different shape from `<tool_call>`, which is
// why the rule is equality against the token rather than a list of markup to
// strip.
test('rejects tool-call parameter markup wrapping the token', () => {
  assertRejects(fixture('parameter-markup-not-an-answer'), /did not answer with qvac-ok/)
})

// These normalize to the token; rejecting them would trade false greens for
// false reds.
for (const reply of ['qvac-ok', 'qvac-ok.', 'qvac-ok!', '`qvac-ok`', '"qvac-ok"', '  qvac-ok  ', '**qvac-ok**', 'QVAC-OK']) {
  test(`accepts a bare answer formatted as ${JSON.stringify(reply)}`, () => {
    verifyAgentOutput(
      mutated('pass-qvac-ok', (d) => {
        d.meta.finalAssistantVisibleText = reply
        d.payloads = [{ text: reply, mediaUrl: null }]
      }),
      MODEL
    )
  })
}

// Prose separates an answer from a mention, however short the reply is.
for (const reply of [
  'I cannot reply with qvac-ok.',
  'I am unable to say qvac-ok here.',
  'Sorry, qvac-ok is not something I can output.',
  'Here you go: qvac-ok.',
  'The answer is qvac-ok',
  'qvac-ok is the token'
]) {
  test(`rejects prose around the token: ${JSON.stringify(reply)}`, () => {
    assertRejects(
      mutated('pass-qvac-ok', (d) => {
        d.meta.finalAssistantVisibleText = reply
        d.payloads = [{ text: reply, mediaUrl: null }]
      }),
      /did not answer with qvac-ok/
    )
  })
}

// Real payload from run 34373081345: an empty `<tool_call></tool_call>` block
// as the entire reply, with `stopReason: stop` and nothing aborted -- so only
// the content check can catch it.
test('rejects leaked tool-call markup as the whole reply', () => {
  assertRejects(fixture('leaked-tool-call-markup'), /replied with no content/)
})

// A token inside tool-call markup was never spoken to the user.
test('does not satisfy the content check from inside tool-call markup', () => {
  assertRejects(
    mutated('leaked-tool-call-markup', (d) => {
      d.meta.finalAssistantVisibleText = '<tool_call>\n{"name":"say","args":{"text":"qvac-ok"}}\n</tool_call>'
      d.payloads = [{ text: d.meta.finalAssistantVisibleText, mediaUrl: null }]
    }),
    /replied with no content/
  )
})

test('does not satisfy the content check from an unclosed tool-call block', () => {
  assertRejects(
    mutated('leaked-tool-call-markup', (d) => {
      d.meta.finalAssistantVisibleText = '<tool_call>{"name":"say","args":{"text":"qvac-ok"'
      d.payloads = [{ text: d.meta.finalAssistantVisibleText, mediaUrl: null }]
    }),
    /replied with no content/
  )
})

// Stripping markup must not swallow a real answer sitting beside it.
test('accepts a real answer alongside leaked markup', () => {
  verifyAgentOutput(
    mutated('pass-qvac-ok', (d) => {
      d.meta.finalAssistantVisibleText = '<tool_call>\n</tool_call>\nqvac-ok'
      d.payloads = [{ text: d.meta.finalAssistantVisibleText, mediaUrl: null }]
    }),
    MODEL
  )
})
