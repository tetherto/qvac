'use strict'

function flattenSegments (output) {
  const segments = []
  for (const entry of output) {
    if (Array.isArray(entry)) {
      segments.push(...entry)
    } else if (entry && typeof entry.text === 'string') {
      segments.push(entry)
    }
  }
  return segments
}

module.exports = { flattenSegments }
