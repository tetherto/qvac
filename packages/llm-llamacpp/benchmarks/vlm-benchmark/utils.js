'use strict'

function stripSurroundingQuotes (value) {
  const s = String(value)
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
    return s.slice(1, -1)
  }
  return s
}

function normalizeArgValue (value) {
  if (value === true || value == null) return value
  let normalized = String(value).trim()
  if (normalized.startsWith('=')) normalized = normalized.slice(1).trim()
  return stripSurroundingQuotes(normalized).trim()
}

// Permissive CLI parser — matches Ian's framework style. Accepts
// `--key value`, `--key=value`, and bare `--flag`.
function parseArgs (argv) {
  const parsed = {}
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i]
    if (!token || !token.startsWith('--')) continue
    const eq = token.indexOf('=')
    if (eq !== -1) {
      parsed[token.slice(2, eq)] = normalizeArgValue(token.slice(eq + 1))
      continue
    }
    const key = token.slice(2)
    const next = argv[i + 1]
    if (!next || next.startsWith('--')) {
      parsed[key] = true
    } else {
      parsed[key] = normalizeArgValue(next)
      i++
    }
  }
  return parsed
}

function csvOrArray (value) {
  if (Array.isArray(value)) return value.slice()
  if (value == null || value === true) return []
  return String(value).split(',').map((x) => x.trim()).filter(Boolean)
}

function truncate (s, n) {
  if (s == null) return null
  const str = String(s)
  return str.length > n ? str.slice(0, n) + '...[truncated]' : str
}

module.exports = { parseArgs, stripSurroundingQuotes, normalizeArgValue, csvOrArray, truncate }
