'use strict'

/**
 * Coerce a greeting subject into a non-empty string. Falls back to `'world'`
 * when the input is `null`/`undefined`/empty. Kept as a pure-JS helper so it
 * can be unit-tested without loading the native addon.
 *
 * @param {*} name
 * @returns {string}
 */
function normalizeName (name) {
  if (name === null || name === undefined) return 'world'
  const s = String(name)
  return s.length === 0 ? 'world' : s
}

module.exports = { normalizeName }
