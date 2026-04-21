'use strict'

/**
 * Compute Word Error Rate between hypothesis and reference.
 * Uses Levenshtein distance on word sequences.
 * @param {string} hypothesis
 * @param {string} reference
 * @returns {number} WER as a ratio (0.0 = perfect, 1.0 = 100% errors)
 */
function computeWER (hypothesis, reference) {
  const hyp = hypothesis.toLowerCase().trim().split(/\s+/).filter(Boolean)
  const ref = reference.toLowerCase().trim().split(/\s+/).filter(Boolean)

  if (ref.length === 0) return hyp.length === 0 ? 0 : 1

  const n = ref.length
  const m = hyp.length
  const dp = Array.from({ length: n + 1 }, () => Array(m + 1).fill(0))

  for (let i = 0; i <= n; i++) dp[i][0] = i
  for (let j = 0; j <= m; j++) dp[0][j] = j

  for (let i = 1; i <= n; i++) {
    for (let j = 1; j <= m; j++) {
      if (ref[i - 1] === hyp[j - 1]) {
        dp[i][j] = dp[i - 1][j - 1]
      } else {
        dp[i][j] = 1 + Math.min(
          dp[i - 1][j],
          dp[i][j - 1],
          dp[i - 1][j - 1]
        )
      }
    }
  }

  return dp[n][m] / n
}

module.exports = { computeWER }
