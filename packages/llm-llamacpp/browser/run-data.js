'use strict'

let nextBatchPromptId = 1n

function prepareMessages(messages) {
  const media = []
  const jsonMessages = []

  for (const message of messages) {
    if (message.type !== 'media') {
      jsonMessages.push(message)
      continue
    }
    if (!(message.content instanceof Uint8Array)) {
      throw new TypeError('Media input content must be a Uint8Array')
    }
    // Admission owns the bytes just like the native TypedArray parser. The
    // caller may mutate or reuse its buffer as soon as runJob() resolves.
    media.push(message.content.slice())
  }

  return { messages: jsonMessages, media }
}

function prepareRunData(data) {
  if (data.length > 0 && Array.isArray(data[0].messages)) {
    const media = []
    const ids = []
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
      return { ...item, id, messages: prepared.messages }
    })
    return { json: stringify(items), media, ids }
  }

  const prepared = prepareMessages(data)
  return { json: stringify(prepared.messages), media: [prepared.media], ids: null }
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
