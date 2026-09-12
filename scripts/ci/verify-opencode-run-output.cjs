'use strict'

/**
 * Verify the JSONL from `opencode run --format json`. The CLI's exit status
 * alone does not prove that it returned an answer. Only assistant text in a
 * completed step counts; a token echoed in metadata or an error does not.
 * These events do not include provider/model metadata, so model selection
 * remains the smoke script's explicit --model argument.
 */
function verifyRunOutput (text) {
  const lines = String(text).split(/\r?\n/).filter((line) => line.trim())
  if (!lines.length) throw new Error('OpenCode produced no stdout')

  const events = lines.map((line, index) => {
    try {
      const event = JSON.parse(line)
      if (!event || typeof event !== 'object' || typeof event.type !== 'string') {
        throw new Error('expected an event object')
      }
      return event
    } catch {
      throw new Error(`OpenCode stdout line ${index + 1} is not a JSON event`)
    }
  })

  if (events.some((event) => event.type === 'error')) {
    throw new Error('OpenCode emitted an error event; see opencode-run.jsonl')
  }

  const finishIndex = events.findLastIndex((event) => event.type === 'step_finish')
  const finish = events[finishIndex]
  if (finish?.part?.type !== 'step-finish' || finish.part.reason !== 'stop') {
    throw new Error('OpenCode did not finish a successful step')
  }
  if (events.slice(finishIndex + 1).some((event) =>
    event.type === 'step_start' || event.type === 'text')) {
    throw new Error('OpenCode output continued after its last completed step')
  }

  const { messageID, sessionID } = finish.part
  if (!messageID || !sessionID || finish.sessionID !== sessionID) {
    throw new Error('OpenCode completed step is missing message/session identity')
  }
  const assistantText = events.slice(0, finishIndex)
    .filter((event) => event.type === 'text' && event.part?.type === 'text' &&
      event.sessionID === sessionID && event.part.sessionID === sessionID &&
      event.part.messageID === messageID && typeof event.part.text === 'string')
    .map((event) => event.part.text).join('\n').trim()

  if (!assistantText) throw new Error('OpenCode produced no assistant text in its completed step')
  // Match the exact-token prompt, so even a short refusal quoting it fails.
  if (assistantText !== 'qvac-ok') {
    throw new Error(`OpenCode did not answer with qvac-ok: ${assistantText.slice(0, 300)}`)
  }
}

module.exports = { verifyRunOutput }

if (require.main === module) {
  const { readFileSync } = require('node:fs')
  const [outputPath] = process.argv.slice(2)
  if (!outputPath) {
    console.error('usage: verify-opencode-run-output.cjs <opencode-run.jsonl>')
    process.exit(2)
  }
  verifyRunOutput(readFileSync(outputPath, 'utf8'))
}
