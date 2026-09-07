'use strict'

/**
 * Unit tests for scripts/ci/verify-openclaw-agent-output.cjs.
 *
 * The fixtures are real `openclaw agent --json` payloads taken from scheduled
 * runs of the OpenClaw upstream compatibility smoke, pruned only of the bulky
 * system-prompt report. They are deliberately not hand-authored: the bug these
 * tests guard against was reading the wrong field paths, and a hand-written
 * fixture would encode the same wrong assumption the verifier made.
 *
 * Mutations below are applied to a real fixture at the real path, for the same
 * reason -- mutating an invented path proves nothing about the live payload.
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

// The regression that motivated this file: the model refused, quoted the token
// back while refusing, and the old verifier reported success.
test('rejects a refusal that quotes qvac-ok back', () => {
  assertRejects(fixture('refusal-quoting-token'), /did not answer the prompt \(\d+ chars/)
})

test('rejects a bare routing token with no content behind it', () => {
  assertRejects(fixture('routing-token-only'), /replied with no content/)
})

test('rejects a reply that ignores the instruction', () => {
  assertRejects(fixture('unrelated-reply'), /did not include qvac-ok/)
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

// Guards the whole class of bug: the old verifier fell through to a
// JSON.stringify of the payload, which always contains the echoed prompt.
test('does not satisfy the content check from the echoed prompt alone', () => {
  const text = mutated('pass-qvac-ok', (d) => {
    d.meta.finalAssistantVisibleText = 'Hello.'
    d.payloads = [{ text: 'Hello.', mediaUrl: null }]
  })
  assert.match(text, /qvac-ok/, 'fixture must still echo the prompt in meta.finalPromptText')
  assertRejects(text, /did not include qvac-ok/)
})
