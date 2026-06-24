'use strict'

/**
 * HyperDB index mapping helpers
 * Used by build-db-spec.js for computed index keys
 */

/**
 * Maps a model record's path to its filename for indexing
 * @param {Object} record - The model record
 * @returns {Array<string>} Array with the filename, or empty if path is missing
 */
exports.mapPathToName = function mapPathToName (record) {
  if (!record.path) return []
  const name = record.path.split('/').pop()
  return name ? [name] : []
}
