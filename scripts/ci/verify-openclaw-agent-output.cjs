'use strict'

/**
 * Verifies the `openclaw agent --json` output produced by
 * scripts/ci/openclaw-upstream-compat-smoke.sh.
 *
 * Every field read here lives under `meta`. Assert against the assistant text
 * and the structured metadata only -- never a `JSON.stringify` of the payload,
 * which always contains the token, "qvac" and the model id, and so cannot fail.
 *
 * Run locally:
 *   node scripts/ci/verify-openclaw-agent-output.cjs <agent-stdout.json> <model>
 *   node --test scripts/ci/__tests__/verify-openclaw-agent-output.test.cjs
 */

// A compliant reply *is* the token, not one that contains it: a length-capped
// substring rule accepted every short non-answer that mentioned it, including
// refusals and a sentence claiming a "qvac-ok command" had run.
const EXPECTED_TOKEN = 'qvac-ok'

// OpenClaw reply-routing directives are control tokens, not content; a small
// model parrots them out of the system prompt with no answer behind them.
const ROUTING_TOKEN = /\[\[[^\]]*\]\]/g

// Leaked tool-call markup is a malformed tool call, not an answer. Contents go
// with the block: a token emitted inside it was never spoken to the user. An
// unclosed opener strips to end of text, since a truncated block is markup too.
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

// Strips markup and the formatting a model wraps a bare answer in. Never
// strips words -- surrounding prose is what separates an answer from a mention.
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
