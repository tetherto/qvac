'use strict'

/**
 * Verifies the `openclaw agent --json` output produced by
 * scripts/ci/openclaw-upstream-compat-smoke.sh.
 *
 * Every field this reads lives under `meta`. An earlier version of these
 * checks read them off the top level, where none of them exist, so each one
 * silently fell through to a `JSON.stringify` of the whole payload -- a blob
 * that always contains "qvac-ok" (echoed back as meta.finalPromptText),
 * "qvac", and the model id. The result was a verifier that could not fail:
 * runs where the model refused outright, or replied with nothing but a routing
 * token, were reported green for weeks. Assert against the assistant text and
 * the structured metadata only, never the serialized blob.
 *
 * Run locally:
 *   node scripts/ci/verify-openclaw-agent-output.cjs <agent-stdout.json> <model>
 *   node --test scripts/ci/__tests__/verify-openclaw-agent-output.test.cjs
 */

// A compliant reply *is* the token. Not "contains" it: a length-capped
// substring check accepted every short non-answer that mentioned it, which is
// how run 34375067376 reported green on "The qvac-ok command is already
// executed successfully." -- 53 characters, well under the old 120 cap, and
// not an answer to anything. Short refusals ("I cannot reply with qvac-ok.")
// sailed through the same way; the cap only ever caught the long refusals.
//
// So normalize and compare for equality. Formatting is tolerated because it is
// not content -- wrapping quotes, backticks, markdown emphasis, a trailing
// period -- but surrounding prose is not.
const EXPECTED_TOKEN = 'qvac-ok'

// OpenClaw reply-routing directives are control tokens, not content. A small
// model parrots them out of the system prompt, historically as a bare
// directive with no answer behind it.
const ROUTING_TOKEN = /\[\[[^\]]*\]\]/g

// Tool-call markup that leaked into visible assistant text is a malformed tool
// call, not an answer. Run 34373081345 replied with a literal empty
// `<tool_call></tool_call>` block and nothing else. The whole block goes,
// contents included: a token emitted *inside* tool-call markup was never
// spoken to the user, so counting it as the answer would be the same kind of
// can't-fail check this verifier exists to remove. An unclosed opener is
// stripped to end-of-text, because a truncated block is markup too.
const TOOL_CALL_MARKUP = /<tool_call\b[\s\S]*?(?:<\/tool_call>|$)/gi

function parseJsonOutput (value) {
  try {
    return JSON.parse(value)
  } catch {
    const lines = value.split(/\r?\n/).map((line) => line.trim()).filter(Boolean)
    for (let index = lines.length - 1; index >= 0; index -= 1) {
      try {
        return JSON.parse(lines[index])
      } catch {
        // Keep scanning for the final JSON record.
      }
    }
    throw new Error('OpenClaw agent stdout did not contain JSON output')
  }
}

/**
 * Reduces a reply to the content the model actually committed to, so it can be
 * compared against the expected token. Strips markup and the formatting a
 * model wraps a bare answer in; deliberately does not strip words.
 */
function normalizeReply (text) {
  return String(text)
    .replace(TOOL_CALL_MARKUP, '')
    .replace(ROUTING_TOKEN, '')
    .trim()
    .replace(/^[\s"'`*_]+/, '')
    .replace(/[\s"'`*_.!]+$/, '')
    .toLowerCase()
}

function assistantTextOf (result) {
  const meta = result.meta ?? {}
  const payloadText = Array.isArray(result.payloads)
    ? result.payloads.map((entry) => String(entry?.text ?? '')).join('\n')
    : ''
  return String(meta.finalAssistantVisibleText ?? '') || payloadText
}

/**
 * Throws with a specific message on the first failed assertion.
 * @param {string} text raw stdout from `openclaw agent --json`
 * @param {string} model expected model id, without the `qvac/` prefix
 */
function verifyAgentOutput (text, model) {
  const trimmed = String(text).trim()
  if (!trimmed) throw new Error('OpenClaw agent produced no stdout')

  const result = parseJsonOutput(trimmed)
  const meta = result.meta ?? {}
  const agentMeta = meta.agentMeta ?? {}

  const finalText = assistantTextOf(result)
  if (!finalText.trim()) {
    throw new Error('OpenClaw agent produced no assistant text')
  }

  const compact = finalText.replace(TOOL_CALL_MARKUP, '').replace(ROUTING_TOKEN, '').trim()
  if (!compact) {
    throw new Error(`OpenClaw agent replied with no content: ${finalText.trim().slice(0, 300)}`)
  }
  if (normalizeReply(compact) !== EXPECTED_TOKEN) {
    throw new Error(
      `OpenClaw agent did not answer with ${EXPECTED_TOKEN}: ${compact.slice(0, 300)}`
    )
  }
  if (meta.aborted === true) {
    throw new Error('OpenClaw agent run was aborted')
  }

  // The real field is meta.executionTrace.fallbackUsed; the flatter paths are
  // kept only as forward-compatible fallbacks.
  const fallbackUsed =
    meta.executionTrace?.fallbackUsed ?? meta.fallbackUsed ?? result.fallbackUsed
  if (fallbackUsed !== undefined && fallbackUsed !== false) {
    throw new Error(`OpenClaw fallback was used: ${fallbackUsed}`)
  }
  if (agentMeta.provider !== 'qvac') {
    throw new Error(`OpenClaw agent did not run through the qvac provider: ${agentMeta.provider}`)
  }
  if (agentMeta.model !== model && agentMeta.model !== `qvac/${model}`) {
    throw new Error(`OpenClaw agent ran model ${agentMeta.model}, expected ${model}`)
  }
}

module.exports = { verifyAgentOutput, parseJsonOutput, assistantTextOf, normalizeReply, EXPECTED_TOKEN }

if (require.main === module) {
  const { readFileSync } = require('node:fs')
  const [outputPath, model] = process.argv.slice(2)
  if (!outputPath || !model) {
    console.error('usage: verify-openclaw-agent-output.cjs <agent-stdout.json> <model>')
    process.exit(2)
  }
  verifyAgentOutput(readFileSync(outputPath, 'utf8'), model)
}
