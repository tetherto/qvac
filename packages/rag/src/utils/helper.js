'use strict'

const { QvacErrorRAG, ERR_CODES } = require('../errors')
// Set up crypto polyfill for uuid-random
try {
  const crypto = require('bare-crypto')
  global.crypto = crypto
} catch (e2) {
  if (typeof global === 'undefined' || (typeof global !== 'undefined' && !global.crypto)) {
    throw new QvacErrorRAG(
      ERR_CODES.DEPENDENCY_REQUIRED,
      'No crypto implementation found. Please ensure a crypto module is available in your environment.'
    )
  }
}
const uuid = require('uuid-random')

/**
 * Calculate the cosine similarity between two vectors.
 * @param {Array} a - The first vector.
 * @param {Array} b - The second vector.
 * @returns {number} - The cosine similarity between the two vectors.
 */
function cosineSimilarity (a, b) {
  let dot = 0; let normA = 0; let normB = 0
  const len = Math.min(a.length, b.length)
  for (let i = 0; i < len; i++) {
    dot += a[i] * b[i]
    normA += a[i] ** 2
    normB += b[i] ** 2
  }
  if (normA === 0 || normB === 0) return 0
  return dot / (Math.sqrt(normA) * Math.sqrt(normB))
}

/**
 * Calculate the text score between a query and a content.
 * @param {string} query - The query.
 * @param {string} content - The content.
 * @returns {number} - The text score between the query and the content.
 */
function calculateTextScore (query, content) {
  const queryTerms = query.toLowerCase().split(/\s+/)
  const contentLower = content.toLowerCase()
  const exactMatches = queryTerms.filter(term => contentLower.includes(term)).length
  const contentTerms = contentLower.split(/\s+/)
  const positions = queryTerms.reduce((map, term) => {
    const pos = contentTerms.indexOf(term)
    if (pos !== -1) map.set(term, pos)
    return map
  }, new Map())
  let proximityScore = 0
  if (positions.size > 1) {
    const posArray = Array.from(positions.values())
    const spread = Math.max(...posArray) - Math.min(...posArray)
    proximityScore = 1 / (1 + spread / 10)
  }
  return (exactMatches / queryTerms.length * 0.7) + (proximityScore * 0.3)
}

/**
 * Normalizes the documents input to ensure it's an array of documents.
 * Each document is expected to be an object with a `content` property.
 * If an element is a string, it is wrapped in an object as { content: <string> }
 * @param {Array<string|PartialDoc>} docs - The documents to normalize.
 * @returns {{normalizedDocs: Array<Doc>, droppedIndices: Array<number>}} An array of normalized documents and the indices of the dropped documents.
 */
function normalizeDocs (docs) {
  if (!Array.isArray(docs)) throw new QvacErrorRAG({ code: ERR_CODES.INVALID_INPUT })

  const seenIds = new Set()
  const normalizedDocs = []
  const droppedIndices = []

  docs.forEach((rawDoc, idx) => {
    const doc = typeof rawDoc === 'string'
      ? { content: rawDoc }
      : rawDoc
    if (!doc || !doc.content || (typeof doc.content === 'string' && doc.content.trim() === '')) {
      droppedIndices.push(idx)
      return
    }
    const id = doc.id || generateId()
    if (seenIds.has(id)) {
      throw new QvacErrorRAG({ code: ERR_CODES.DUPLICATE_DOCUMENT_ID, adds: id })
    }
    seenIds.add(id)
    normalizedDocs.push({ ...doc, id })
  })
  return {
    normalizedDocs,
    droppedIndices
  }
}

/**
 * Generates a unique ID using UUID v4.
 * @returns {string} A unique identifier.
 */
function generateId () {
  return uuid()
}

/**
   * Maintain min-heap property when adding elements.
   * @param {Array} heap - The heap array.
   * @param {number} index - The index of the element to heapify up.
   * @private
   */
function heapifyUp (heap, index) {
  while (index > 0) {
    const parentIndex = Math.floor((index - 1) / 2)
    if (heap[parentIndex].similarity <= heap[index].similarity) break
    [heap[parentIndex], heap[index]] = [heap[index], heap[parentIndex]]
    index = parentIndex
  }
}

/**
   * Maintain min-heap property when removing elements.
   * @param {Array} heap - The heap array.
   * @param {number} index - The index of the element to heapify down.
   * @private
   */
function heapifyDown (heap, index) {
  const heapSize = heap.length

  while (true) {
    let smallest = index
    const leftChild = 2 * index + 1
    const rightChild = 2 * index + 2
    if (leftChild < heapSize && heap[leftChild].similarity < heap[smallest].similarity) {
      smallest = leftChild
    }
    if (rightChild < heapSize && heap[rightChild].similarity < heap[smallest].similarity) {
      smallest = rightChild
    }
    if (smallest === index) break
    [heap[index], heap[smallest]] = [heap[smallest], heap[index]]
    index = smallest
  }
}

/**
   * Reservoir sampling algorithm for efficient random sampling.
   * @param {Array} array - The array to sample from.
   * @param {number} sampleSize - The number of items to sample.
   * @returns {Array} A random sample of the specified size.
   * @private
   */
function reservoirSample (array, sampleSize) {
  if (sampleSize >= array.length) {
    return array.slice()
  }
  const sample = array.slice(0, sampleSize)
  for (let i = sampleSize; i < array.length; i++) {
    const randomIndex = Math.floor(Math.random() * (i + 1))
    if (randomIndex < sampleSize) {
      sample[randomIndex] = array[i]
    }
  }
  return sample
}

/**
 * Creates an LRU (Least Recently Used) cache.
 * @param {number} maxSize - Maximum number of entries to cache.
 * @returns {Object} Cache object with get, set, has, delete, clear, and size methods.
 */
function createLRUCache (maxSize) {
  const cache = new Map()

  return {
    get (key) {
      if (!cache.has(key)) return undefined
      // Move to end (most recently used)
      const value = cache.get(key)
      cache.delete(key)
      cache.set(key, value)
      return value
    },

    set (key, value) {
      // If key exists, delete first to update position
      if (cache.has(key)) {
        cache.delete(key)
      }
      cache.set(key, value)
      // Evict LRU (first entry) if over capacity
      if (cache.size > maxSize) {
        const lruKey = cache.keys().next().value
        cache.delete(lruKey)
      }
    },

    has (key) {
      return cache.has(key)
    },

    delete (key) {
      return cache.delete(key)
    },

    clear () {
      cache.clear()
    },

    get size () {
      return cache.size
    }
  }
}

module.exports = {
  cosineSimilarity,
  calculateTextScore,
  normalizeDocs,
  generateId,
  reservoirSample,
  heapifyUp,
  heapifyDown,
  createLRUCache
}
