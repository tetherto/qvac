'use strict'

// A manifest entry pinned to the model registry by `s3Path`, with no HTTP urls.
function isS3Only(entry) {
  return (
    !!entry &&
    typeof entry.s3Path === 'string' &&
    entry.s3Path.length > 0 &&
    !(Array.isArray(entry.urls) && entry.urls.length > 0)
  )
}

module.exports = { isS3Only }
