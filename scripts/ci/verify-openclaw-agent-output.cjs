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

// A compliant reply is the token and little else. The cap is deliberately
// loose -- observed passes are under 50 characters and observed refusals run
// past 300 -- so it rejects non-answers without policing phrasing. It exists
// because a refusal quotes the token back while declining ("...your specific
// query about \"qvac-ok\"..."), which a bare substring check would accept.
const MAX_COMPLIANT_REPLY_CHARS = 120

// OpenClaw reply-routing directives are control tokens, not content. A small
// model parrots them out of the system prompt, historically as a bare
// directive with no answer behind it.
const ROUTING_TOKEN = /\[\[[^\]]*\]\]/g

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

  const compact = finalText.replace(ROUTING_TOKEN, '').trim()
  if (!compact) {
    throw new Error(`OpenClaw agent replied with no content: ${finalText.trim().slice(0, 300)}`)
  }
  if (!/qvac-ok/i.test(compact)) {
    throw new Error(`OpenClaw agent response did not include qvac-ok: ${compact.slice(0, 300)}`)
  }
  if (compact.length > MAX_COMPLIANT_REPLY_CHARS) {
    throw new Error(
      `OpenClaw agent did not answer the prompt (${compact.length} chars, expected <= ${MAX_COMPLIANT_REPLY_CHARS}): ${compact.slice(0, 300)}`
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

module.exports = { verifyAgentOutput, parseJsonOutput, assistantTextOf, MAX_COMPLIANT_REPLY_CHARS }

if (require.main === module) {
  const { readFileSync } = require('node:fs')
  const [outputPath, model] = process.argv.slice(2)
  if (!outputPath || !model) {
    console.error('usage: verify-openclaw-agent-output.cjs <agent-stdout.json> <model>')
    process.exit(2)
  }
  verifyAgentOutput(readFileSync(outputPath, 'utf8'), model)
}
