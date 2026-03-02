'use strict'

const test = require('brittle')
const fs = require('bare-fs')
const path = require('bare-path')
const MockONNXOcr = require('../MockONNXOcr.js')

const TMP_DIR = path.resolve('.', 'test', 'tmp')

function createModel () {
  return new MockONNXOcr({
    params: {
      langList: ['en'],
      pathDetector: 'detector.onnx',
      pathRecognizer: 'recognizer_latin.onnx'
    },
    opts: {}
  })
}

function ensureTmpDir () {
  if (!fs.existsSync(TMP_DIR)) {
    fs.mkdirSync(TMP_DIR, { recursive: true })
  }
}

function writeTmpFile (filename, buffer) {
  ensureTmpDir()
  const filePath = path.join(TMP_DIR, filename)
  fs.writeFileSync(filePath, buffer)
  return filePath
}

function cleanupTmpFile (filePath) {
  try { fs.unlinkSync(filePath) } catch (_) {}
}

/**
 * Helper to create a minimal valid BMP file buffer.
 * Standard BITMAPINFOHEADER (40 bytes), 24-bit, 2x2 pixels.
 */
function createValidBmp ({ width = 2, height = 2, bitsPerPixel = 24, infoHeaderSize = 40 } = {}) {
  const bytesPerPixel = bitsPerPixel / 8
  const rowSize = Math.ceil((width * bytesPerPixel) / 4) * 4
  const pixelDataSize = rowSize * Math.abs(height)
  const pixelDataOffset = 14 + infoHeaderSize
  const fileSize = pixelDataOffset + pixelDataSize

  const buf = Buffer.alloc(fileSize)

  // BMP file header (14 bytes)
  buf[0] = 0x42 // 'B'
  buf[1] = 0x4D // 'M'
  buf.writeUInt32LE(fileSize, 2)
  buf.writeUInt32LE(pixelDataOffset, 10)

  // Info header
  buf.writeUInt32LE(infoHeaderSize, 14)
  if (infoHeaderSize >= 40) {
    buf.writeInt32LE(width, 18)
    buf.writeInt32LE(height, 22)
    buf.writeUInt16LE(1, 26) // planes
    buf.writeUInt16LE(bitsPerPixel, 28)
  } else if (infoHeaderSize >= 12) {
    buf.writeUInt16LE(width, 18)
    buf.writeInt16LE(height, 20)
  }

  // Fill pixel data with dummy values
  for (let i = pixelDataOffset; i < fileSize; i++) {
    buf[i] = 0xFF
  }

  return buf
}

/**
 * Test that a zero-byte file is rejected.
 */
test('BMP parser rejects zero-byte file', async t => {
  const model = createModel()
  const filePath = writeTmpFile('zero.bmp', Buffer.alloc(0))

  try {
    model.getImage(filePath)
    t.fail('Should have thrown an error')
  } catch (err) {
    t.ok(err.message.includes('Invalid BMP file or insufficient data'), 'Should report invalid/insufficient data')
  } finally {
    cleanupTmpFile(filePath)
  }
})

/**
 * Test that a file too small to contain a BMP header is rejected.
 */
test('BMP parser rejects file smaller than minimum header size', async t => {
  const model = createModel()
  const filePath = writeTmpFile('tiny.bmp', Buffer.alloc(10))

  try {
    model.getImage(filePath)
    t.fail('Should have thrown an error')
  } catch (err) {
    t.ok(err.message.includes('Invalid BMP file or insufficient data'), 'Should report invalid/insufficient data')
  } finally {
    cleanupTmpFile(filePath)
  }
})

/**
 * Test that a file with wrong magic bytes (not BMP) is rejected.
 */
test('BMP parser rejects file with non-BMP magic bytes', async t => {
  const model = createModel()
  const buf = Buffer.alloc(100)
  buf[0] = 0x89 // PNG magic byte
  buf[1] = 0x50
  const filePath = writeTmpFile('not_bmp.bmp', buf)

  try {
    model.getImage(filePath)
    t.fail('Should have thrown an error')
  } catch (err) {
    t.ok(err.message.includes('Not a valid BMP file'), 'Should report not a valid BMP')
  } finally {
    cleanupTmpFile(filePath)
  }
})

/**
 * Test that a BMP with truncated info header is rejected.
 */
test('BMP parser rejects BMP with incomplete info header', async t => {
  const model = createModel()
  // Create a buffer with BMP magic bytes but truncated after the info header size field
  // BMP header = 14 bytes, then info header size says 40 but we only give 20 total bytes
  const buf = Buffer.alloc(20)
  buf[0] = 0x42 // 'B'
  buf[1] = 0x4D // 'M'
  buf.writeUInt32LE(20, 2) // file size
  buf.writeUInt32LE(40, 14) // info header size claims 40 bytes, but file is only 20 bytes

  const filePath = writeTmpFile('truncated_header.bmp', buf)

  try {
    model.getImage(filePath)
    t.fail('Should have thrown an error')
  } catch (err) {
    t.ok(err.message.includes('Incomplete BMP data'), 'Should report incomplete BMP data')
  } finally {
    cleanupTmpFile(filePath)
  }
})

/**
 * Test that a BMP with unsupported (too small) info header size is rejected.
 */
test('BMP parser rejects BMP with unsupported info header size', async t => {
  const model = createModel()
  // Create buffer with BMP magic, and info header size = 8 (less than minimum 12)
  const buf = Buffer.alloc(30)
  buf[0] = 0x42
  buf[1] = 0x4D
  buf.writeUInt32LE(30, 2)
  buf.writeUInt32LE(8, 14) // info header size too small

  const filePath = writeTmpFile('bad_header_size.bmp', buf)

  try {
    model.getImage(filePath)
    t.fail('Should have thrown an error')
  } catch (err) {
    t.ok(err.message.includes('Unsupported BMP Information Header size'), 'Should report unsupported header size')
  } finally {
    cleanupTmpFile(filePath)
  }
})

/**
 * Test that a valid BMP with standard 40-byte header parses correctly.
 */
test('BMP parser handles valid BMP with 40-byte info header', async t => {
  const model = createModel()
  const bmpBuffer = createValidBmp({ width: 4, height: 3 })
  const filePath = writeTmpFile('valid_40.bmp', bmpBuffer)

  try {
    const result = model.getImage(filePath)
    t.is(result.width, 4, 'Width should be 4')
    t.is(result.height, 3, 'Height should be 3')
    t.ok(result.data, 'Should return pixel data buffer')
    t.ok(result.data.length > 0, 'Pixel data should not be empty')
  } finally {
    cleanupTmpFile(filePath)
  }
})

/**
 * Test that a valid BMP with 12-byte OS/2 header parses correctly.
 */
test('BMP parser handles valid BMP with 12-byte info header (OS/2 format)', async t => {
  const model = createModel()
  const bmpBuffer = createValidBmp({ width: 3, height: 2, infoHeaderSize: 12 })
  const filePath = writeTmpFile('valid_12.bmp', bmpBuffer)

  try {
    const result = model.getImage(filePath)
    t.is(result.width, 3, 'Width should be 3')
    t.is(result.height, 2, 'Height should be 2')
    t.ok(result.data, 'Should return pixel data buffer')
  } finally {
    cleanupTmpFile(filePath)
  }
})

/**
 * Test that BMP parser handles file-not-found gracefully.
 */
test('BMP parser throws on non-existent file', async t => {
  const model = createModel()

  let errorCaught = false
  try {
    model.getImage('/nonexistent/path/image.bmp')
  } catch (err) {
    errorCaught = true
    t.ok(err.message.includes('no such file or directory') || err.message.includes('ENOENT'),
      'Should throw file not found error')
  }
  t.ok(errorCaught, 'Error should be caught')
})

// Cleanup tmp directory after all tests
test('Cleanup temp directory', async t => {
  try { fs.rmdirSync(TMP_DIR) } catch (_) {}
  t.pass('Cleanup complete')
})
