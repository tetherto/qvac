'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const { readFileSync } = require('node:fs')
const { join } = require('node:path')
const { verifyRunOutput } = require('../verify-opencode-run-output.cjs')

// Unmodified output from the September 7, 2026 scheduled smoke (OpenCode 1.18.29):
// https://github.com/tetherto/qvac/actions/runs/34094267157
// Mutate actual event paths to avoid encoding an invented JSONL contract.
const fixture = readFileSync(join(__dirname, 'fixtures/opencode-pass-qvac-ok.jsonl'), 'utf8')
function mutated (mutate) {
  const events = fixture.trim().split('\n').map((line) => JSON.parse(line))
  mutate(events)
  return events.map((event) => JSON.stringify(event)).join('\n')
}

test('accepts the real successful OpenCode run', () => {
  verifyRunOutput(fixture)
})

// This scheduled run was marked successful despite the refusal:
// https://github.com/tetherto/qvac/actions/runs/33846997875
test('rejects the real refusal that was reported as a successful smoke', () => {
  const refusal = readFileSync(join(__dirname, 'fixtures/opencode-refusal-quoting-token.jsonl'), 'utf8')
  assert.throws(() => verifyRunOutput(refusal), /did not answer with qvac-ok/)
})

test('accepts blank lines, CRLF and surrounding answer whitespace', () => {
  verifyRunOutput('\r\n' + mutated((events) => {
    events[1].part.text = ' qvac-ok\n'
  }).replaceAll('\n', '\r\n') + '\r\n')
})

for (const text of ['', ' \n\t']) {
  test(`rejects empty stdout ${JSON.stringify(text)}`, () => {
    assert.throws(() => verifyRunOutput(text), /produced no stdout/)
  })
}

for (const line of ['not json', 'null', '[]', '{}']) {
  test(`rejects a malformed event: ${line}`, () => {
    assert.throws(() => verifyRunOutput(fixture + line), /not a JSON event/)
  })
}

for (const text of ['', 'Hello.', 'I cannot reply with qvac-ok.', '[[reply_to_current]]']) {
  test(`rejects a non-answer: ${JSON.stringify(text)}`, () => {
    assert.throws(() => verifyRunOutput(mutated((events) => {
      events[1].part.text = text
    })), /no assistant text|did not answer with qvac-ok/)
  })
}

test('does not accept the token from metadata', () => {
  assert.throws(() => verifyRunOutput(mutated((events) => {
    events[1].part.text = 'Hello.'
    events[1].prompt = 'qvac-ok'
  })), /did not answer with qvac-ok/)
})

test('rejects an error event even after a valid answer', () => {
  assert.throws(() => verifyRunOutput(fixture + JSON.stringify({
    type: 'error', error: { name: 'APIError', data: { message: 'backend unavailable' } }
  })), /emitted an error event/)
})

test('rejects an incomplete run', () => {
  assert.throws(() => verifyRunOutput(mutated((events) => events.pop())), /did not finish/)
})

for (const reason of ['length', 'error', 'tool-calls', undefined]) {
  test(`rejects a final step with reason ${reason}`, () => {
    assert.throws(() => verifyRunOutput(mutated((events) => {
      events[2].part.reason = reason
    })), /did not finish/)
  })
}

for (const index of [0, 1]) {
  test(`rejects an unfinished event after completion (${index})`, () => {
    assert.throws(() => verifyRunOutput(mutated((events) => {
      events.push(events[index])
    })), /continued after/)
  })
}

for (const field of ['messageID', 'sessionID']) {
  test(`rejects text from a different ${field}`, () => {
    assert.throws(() => verifyRunOutput(mutated((events) => {
      events[1].part[field] = 'other'
    })), /no assistant text/)
  })
  test(`rejects a completed step without ${field}`, () => {
    assert.throws(() => verifyRunOutput(mutated((events) => {
      delete events[2].part[field]
    })), /missing message\/session identity/)
  })
}
