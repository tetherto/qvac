import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { looksBinary } from '../src/serve/routes/vector-stores.js'

describe('looksBinary', () => {
  it('returns false for plain UTF-8 text', () => {
    assert.equal(looksBinary(Buffer.from('Hello, world.\nSecond line.', 'utf8')), false)
  })

  it('returns false for empty buffers (handled separately by empty_file)', () => {
    assert.equal(looksBinary(Buffer.alloc(0)), false)
  })

  it('returns false for multibyte UTF-8 (emoji, CJK)', () => {
    assert.equal(looksBinary(Buffer.from('café — 中文 — 🎉', 'utf8')), false)
  })

  it('returns true for a PNG header', () => {
    // PNG magic: 89 50 4E 47 0D 0A 1A 0A — contains 0x00 in the IHDR length that follows.
    const png = Buffer.from([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
      0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52
    ])
    assert.equal(looksBinary(png), true)
  })

  it('returns true for a PDF (NUL inside xref)', () => {
    // Real PDFs always contain NUL bytes in cross-reference tables.
    const pdf = Buffer.concat([
      Buffer.from('%PDF-1.4\n'),
      Buffer.from([0x00, 0x10, 0x20])
    ])
    assert.equal(looksBinary(pdf), true)
  })

  it('only sniffs the first 8 KB (so a NUL deep in the file is still flagged because it lies inside the window when within 8 KB)', () => {
    // Sanity-check the windowing: a NUL just past 8 KB is ignored.
    const padded = Buffer.concat([
      Buffer.alloc(8192, 0x20),
      Buffer.from([0x00])
    ])
    assert.equal(looksBinary(padded), false)
  })
})
