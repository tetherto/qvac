import assert from 'node:assert/strict'
import test from 'node:test'

import { createQvac } from '../src/provider.js'

// End-to-end managed-mode smoke test against a REAL `qvac serve`. Opt-in only:
// it requires `@qvac/cli` installed and downloads/loads a real model over the
// P2P registry, which is slow and network-dependent. Run with:
//
//   QVAC_INTEGRATION_TEST=1 bun run test
//
// Override the model with QVAC_INTEGRATION_MODEL if QWEN3_600M_INST_Q4 is not
// the most convenient local model.
const integration = process.env['QVAC_INTEGRATION_TEST'] === '1'
const MODEL = process.env['QVAC_INTEGRATION_MODEL'] ?? 'QWEN3_600M_INST_Q4'

test('managed mode runs an end-to-end chat completion and tears down', { skip: !integration }, async () => {
  const provider = await createQvac({
    mode: 'managed',
    models: [MODEL],
    // First run downloads the model over P2P — give it plenty of headroom.
    serveStartTimeout: 600_000
  })

  try {
    assert.ok(provider.port > 0)
    assert.ok(provider.pid > 0)

    const { generateText } = await import('ai')
    const { text } = await generateText({
      model: provider.chatModel(MODEL),
      prompt: 'Reply with the single word: pong'
    })

    assert.equal(typeof text, 'string')
    assert.ok(text.length > 0, 'expected a non-empty completion')
  } finally {
    await provider.close()
  }
})
