'use strict'

function splitWords(text) {
  return text.toLowerCase().trim().split(/\s+/).filter(Boolean)
}

function createDistanceTable(rows, cols) {
  return Array.from({ length: rows + 1 }, () => Array(cols + 1).fill(0))
}

function initReferenceBorder(dp, refLength) {
  for (let i = 0; i <= refLength; i++) dp[i][0] = i
}

function initHypothesisBorder(dp, hypLength) {
  for (let j = 0; j <= hypLength; j++) dp[0][j] = j
}

function fillDistanceRow(dp, ref, hyp, i) {
  for (let j = 1; j <= hyp.length; j++) {
    dp[i][j] =
      ref[i - 1] === hyp[j - 1]
        ? dp[i - 1][j - 1]
        : 1 + Math.min(dp[i - 1][j], dp[i][j - 1], dp[i - 1][j - 1])
  }
}

function fillDistanceTable(dp, ref, hyp) {
  for (let i = 1; i <= ref.length; i++) {
    fillDistanceRow(dp, ref, hyp, i)
  }
}

function wordEditDistance(ref, hyp) {
  const dp = createDistanceTable(ref.length, hyp.length)
  initReferenceBorder(dp, ref.length)
  initHypothesisBorder(dp, hyp.length)
  fillDistanceTable(dp, ref, hyp)
  return dp[ref.length][hyp.length]
}

/**
 * Compute Word Error Rate between hypothesis and reference.
 * Uses Levenshtein distance on word sequences.
 * @param {string} hypothesis
 * @param {string} reference
 * @returns {number} WER as a ratio (0.0 = perfect, 1.0 = 100% errors)
 */
function computeWER(hypothesis, reference) {
  const hyp = splitWords(hypothesis)
  const ref = splitWords(reference)

  if (ref.length === 0) return hyp.length === 0 ? 0 : 1

  return wordEditDistance(ref, hyp) / ref.length
}

module.exports = { computeWER }
