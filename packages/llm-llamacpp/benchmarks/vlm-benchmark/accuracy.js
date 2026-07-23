'use strict'

// Object-recall scoring for V1.
//
// Pipeline:
//   1. Strip <think>...</think> blocks (reasoning models emit them
//      before the actual answer; Qwen3.5 is one).
//   2. Try a strict comma-split (the prompt explicitly asks for that
//      shape). If the model complied, exact-token matching is enough.
//   3. Fall back to word-boundary substring matching over the whole
//      stripped answer — handles prose-style responses where the model
//      still names every object, just in sentences.
//
// Plural / alternate forms come from the config (see
// vlm-bench.config.js §case.groundTruth) so we don't need a stemmer.

const PUNCT_REGEX = /^[\s.,;:!?"'`()[\]{}<>*-]+|[\s.,;:!?"'`()[\]{}<>*-]+$/g
const THINK_BLOCK_REGEX = /<think>[\s\S]*?<\/think>/gi

function normaliseToken (raw) {
  if (raw == null) return ''
  return String(raw).toLowerCase().replace(PUNCT_REGEX, '').trim()
}

function stripThinkBlocks (answer) {
  if (answer == null) return ''
  return String(answer).replace(THINK_BLOCK_REGEX, '').trim()
}

function splitAnswer (answer) {
  if (answer == null) return []
  const byComma = String(answer).split(',')
  const tokens = byComma.length > 1
    ? byComma
    : String(answer).split(/[\n\r\t ]+/)
  return tokens.map(normaliseToken).filter(Boolean)
}

function escapeRegex (s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

// Word-boundary substring match — case-insensitive. "umbrella" matches
// inside "**Top Center:** A black umbrella.".
function answerContainsForm (haystack, form) {
  const re = new RegExp(`\\b${escapeRegex(form)}\\b`, 'i')
  return re.test(haystack)
}

function scoreAnswer (answer, groundTruth) {
  const cleaned = stripThinkBlocks(answer)
  const predicted = splitAnswer(cleaned)
  const predictedSet = new Set(predicted)

  const matched = []
  const missed = []
  for (const entry of groundTruth) {
    const accepts = (entry.accepts || []).map(normaliseToken)
    // Strict comma-token match first; fall back to word-bounded
    // substring search over the whole cleaned answer for prose-style
    // responses.
    const found = accepts.some((form) => predictedSet.has(form)) ||
      accepts.some((form) => answerContainsForm(cleaned, form))
    if (found) matched.push(entry.canonical)
    else missed.push(entry.canonical)
  }

  // Extras: predicted comma-tokens with no ground-truth match. Only
  // meaningful when the model produced a clean comma list; for prose
  // answers we surface an empty list rather than mis-flagging every
  // English word.
  const looksLikeList = String(cleaned).split(',').length > 1
  const allAccepted = new Set(
    groundTruth.flatMap((e) => (e.accepts || []).map(normaliseToken))
  )
  const extras = looksLikeList
    ? predicted.filter((tok) => !allAccepted.has(tok))
    : []

  const total = groundTruth.length
  return {
    objectsRecalled: matched.length,
    objectsTotal: total,
    recallScore: total ? matched.length / total : 0,
    objectsMatched: matched,
    objectsMissed: missed,
    extras
  }
}

module.exports = { scoreAnswer, splitAnswer, normaliseToken, stripThinkBlocks }
