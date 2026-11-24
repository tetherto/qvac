'use strict'

function ensureParentDirectory(module, path) {
  if (typeof path !== 'string' || path === '') return
  const separator = path.lastIndexOf('/')
  if (separator <= 0) return
  module.FS.mkdirTree(path.slice(0, separator))
}

function ensureMessageCacheDirectories(module, serializedMessages) {
  const messages = JSON.parse(serializedMessages)
  for (const message of messages) {
    if (!message || typeof message !== 'object') continue
    ensureParentDirectory(module, message.cacheKey)
  }
}

module.exports = { ensureMessageCacheDirectories, ensureParentDirectory }
