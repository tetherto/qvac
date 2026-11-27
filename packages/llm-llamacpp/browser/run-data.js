'use strict'

const { pathParts } = require('./persistent-files.js')

let nextBatchPromptId = 1n

function isMediaPath(item) {
  return (
    item !== null &&
    typeof item === 'object' &&
    item.type === 'media' &&
    typeof item.content === 'string' &&
    item.content !== ''
  )
}

// The engine cannot open a media path in the browser: its files live in the
// worker, not the engine's filesystem. Bytes arrive as top-level media items
// and leave content-less markers in the text, so only a path is rejected.
function rejectMediaPaths(input) {
  if (typeof input !== 'string') return
  let messages
  try {
    messages = JSON.parse(input)
  } catch {
    return
  }
  if (!Array.isArray(messages)) return
  for (const message of messages) {
    if (
      isMediaPath(message) ||
      (Array.isArray(message?.content) && message.content.some(isMediaPath))
    ) {
      throw new TypeError(
        'Media paths are not supported in the browser build; pass the media bytes as a Uint8Array'
      )
    }
  }
}

function prepareMessages(messages) {
  const media = []
  const jsonMessages = []
  const hydratePaths = new Set()
  const cachePaths = new Set()

  for (const message of messages) {
    if (message.type !== 'media') {
      if (message.type === 'text') rejectMediaPaths(message.input)
      const normalized = { ...message }
      if (typeof message.cacheKey === 'string' && message.cacheKey.length > 0) {
        normalized.cacheKey = `/${pathParts(message.cacheKey).join('/')}`
        hydratePaths.add(normalized.cacheKey)
        if (message.ephemeral !== true) cachePaths.add(normalized.cacheKey)
      }
      if (typeof message.baseCacheKey === 'string' && message.baseCacheKey.length > 0) {
        normalized.baseCacheKey = `/${pathParts(message.baseCacheKey).join('/')}`
        hydratePaths.add(normalized.baseCacheKey)
      }
      jsonMessages.push(normalized)
      continue
    }
    if (!(message.content instanceof Uint8Array)) {
      throw new TypeError('Media input content must be a Uint8Array')
    }
    // Admission owns the bytes just like the native TypedArray parser. The
    // caller may mutate or reuse its buffer as soon as runJob() resolves.
    media.push(new Uint8Array(message.content))
  }

  return { messages: jsonMessages, media, hydratePaths, cachePaths }
}

function prepareRunData(data) {
  if (data.length > 0 && Array.isArray(data[0].messages)) {
    const media = []
    const ids = []
    const hydratePaths = new Set()
    const cachePaths = new Set()
    const seen = new Set()
    for (const item of data) {
      const id = item.id
      if (id === undefined || id === null) continue
      if (typeof id !== 'string' || id.length === 0) {
        throw new TypeError('Batch prompt id must be a non-empty string when provided')
      }
      if (id.startsWith('batch-')) {
        throw new TypeError(
          `Batch prompt id prefix 'batch-' is reserved for auto-minted ids: ${id}`
        )
      }
      if (seen.has(id)) throw new TypeError(`Duplicate batch prompt id: ${id}`)
      seen.add(id)
    }
    const items = data.map((item) => {
      let id = item.id
      if (id === undefined || id === null) {
        do {
          id = `batch-${nextBatchPromptId++}`
        } while (seen.has(id))
        seen.add(id)
      }
      ids.push(id)
      const prepared = prepareMessages(item.messages)
      media.push(prepared.media)
      for (const path of prepared.hydratePaths) hydratePaths.add(path)
      for (const path of prepared.cachePaths) cachePaths.add(path)
      return { ...item, id, messages: prepared.messages }
    })
    return {
      json: stringify(items),
      media,
      ids,
      hydratePaths: [...hydratePaths],
      cachePaths: [...cachePaths]
    }
  }

  const prepared = prepareMessages(data)
  return {
    json: stringify(prepared.messages),
    media: [prepared.media],
    ids: null,
    hydratePaths: [...prepared.hydratePaths],
    cachePaths: [...prepared.cachePaths]
  }
}

function stringify(value) {
  return JSON.stringify(value, (key, item) => {
    if (typeof item === 'number' && !Number.isFinite(item)) {
      throw new TypeError(`${key || 'value'} must be a finite number`)
    }
    return item
  })
}

module.exports = { prepareRunData }
