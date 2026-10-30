// Test fixtures for the e2e suite.

import { crc32, deflateSync } from 'node:zlib'

// 1x1 transparent PNG, for multipart image tests.
export function tinyPng(): Buffer {
  return Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
    'base64'
  )
}

// A black RGB PNG of any size, for tests that depend on the image dimensions.
export function blackPng(width: number, height: number): Buffer {
  const chunk = (type: string, data: Buffer): Buffer => {
    const body = Buffer.concat([Buffer.from(type, 'latin1'), data])
    const out = Buffer.alloc(body.length + 8)
    out.writeUInt32BE(data.length, 0)
    body.copy(out, 4)
    out.writeUInt32BE(crc32(body), body.length + 4)
    return out
  }
  const header = Buffer.alloc(13)
  header.writeUInt32BE(width, 0)
  header.writeUInt32BE(height, 4)
  header[8] = 8 // bit depth
  header[9] = 2 // RGB
  // Each row is a filter byte followed by its pixels.
  const pixels = Buffer.alloc((width * 3 + 1) * height)
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(pixels)),
    chunk('IEND', Buffer.alloc(0))
  ])
}

// 1x1 baseline JPEG, for image tests that need the JPEG decoder.
export function tinyJpeg(): Buffer {
  return Buffer.from(
    '/9j/4AAQSkZJRgABAQAASABIAAD/wAARCAABAAEDASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBg' +
      'cICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcY' +
      'GRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpK' +
      'Wmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/8QAHwEAAwEBAQEBAQEB' +
      'AQAAAAAAAAECAwQFBgcICQoL/8QAtREAAgECBAQDBAcFBAQAAQJ3AAECAxEEBSExBhJBUQdhcRMiMoEIFEKRobHBCS' +
      'MzUvAVYnLRChYkNOEl8RcYGRomJygpKjU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6goOEhYaH' +
      'iImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3uLm6wsPExcbHyMnK0tPU1dbX2Nna4uPk5ebn6Onq8vP09fb3+Pn6/9' +
      'sAQwAGBgYGBgYKBgYKDgoKCg4SDg4ODhIXEhISEhIXHBcXFxcXFxwcHBwcHBwcIiIiIiIiJycnJycsLCwsLCwsLCws' +
      '/9sAQwEHBwcLCgsTCgoTLh8aHy4uLi4uLi4uLi4uLi4uLi4uLi4uLi4uLi4uLi4uLi4uLi4uLi4uLi4uLi4uLi4uLi' +
      '4u/90ABAAB/9oADAMBAAIRAxEAPwDs6KKK8c/ST//Z',
    'base64'
  )
}

// 1-second 16 kHz mono 16-bit PCM silent WAV, for transcription/translation.
export function silenceWav(): Buffer {
  const b = Buffer.alloc(32044)
  b.write('RIFF', 0)
  b.writeUInt32LE(32036, 4)
  b.write('WAVE', 8)
  b.write('fmt ', 12)
  b.writeUInt32LE(16, 16)
  b.writeUInt16LE(1, 20)
  b.writeUInt16LE(1, 22)
  b.writeUInt32LE(16000, 24)
  b.writeUInt32LE(32000, 28)
  b.writeUInt16LE(2, 32)
  b.writeUInt16LE(16, 34)
  b.write('data', 36)
  b.writeUInt32LE(32000, 40)
  return b
}

export function textFile(content: string): Buffer {
  return Buffer.from(content, 'utf8')
}
