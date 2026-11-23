'use strict'

function ensureParentDirectory(module, path) {
  if (typeof path !== 'string' || path === '') return
  const separator = path.lastIndexOf('/')
  if (separator <= 0) return
  module.FS.mkdirTree(path.slice(0, separator))
}

function ensureMessageCacheDirectories(module, serializedMessages) {
  const visit = (messages) => {
    if (!Array.isArray(messages)) return
    for (const message of messages) {
      if (!message || typeof message !== 'object') continue
      if (Array.isArray(message.messages)) visit(message.messages)
      ensureParentDirectory(module, message.cacheKey)
    }
  }
  visit(JSON.parse(serializedMessages))
}

module.exports = { ensureMessageCacheDirectories, ensureParentDirectory }
