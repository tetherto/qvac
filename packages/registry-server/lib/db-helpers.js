'use strict'

/**
 * HyperDB index mapping helpers
 * Used by build-db-spec.js for computed index keys
 */
exports.mapPathToName = function mapPathToName (record) {
  if (!record.path) return []
  const name = record.path.split('/').pop()
  return name ? [name] : []
}
