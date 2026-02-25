'use strict'

const { ONNXOcr, QvacErrorAddonOcr, ERR_CODES } = require('../..')
const test = require('brittle')
const fs = require('bare-fs')
const path = require('bare-path')
const { isMobile } = require('./utils')

const MOBILE_TIMEOUT = 600 * 1000
const DESKTOP_TIMEOUT = 60 * 1000
const TEST_TIMEOUT = isMobile ? MOBILE_TIMEOUT : DESKTOP_TIMEOUT

const TMP_DIR = isMobile
  ? path.join(global.testDir || '/tmp', 'test-tmp')
  : path.resolve('.', 'test', 'tmp')

function setupTmpDir () {
  if (!fs.existsSync(TMP_DIR)) {
    fs.mkdirSync(TMP_DIR, { recursive: true })
  }
}

function writeTmpFile (name, buffer) {
  setupTmpDir()
  const filePath = path.join(TMP_DIR, name)
  fs.writeFileSync(filePath, buffer)
  return filePath
}

function cleanupTmpDir () {
  if (fs.existsSync(TMP_DIR)) {
    const files = fs.readdirSync(TMP_DIR)
    for (const file of files) {
      fs.unlinkSync(path.join(TMP_DIR, file))
    }
    fs.rmdirSync(TMP_DIR)
  }
}

function createOcrInstance () {
  return new ONNXOcr({
    params: {
      pathDetector: 'models/ocr/rec_dyn/detector_craft.onnx',
      pathRecognizer: 'models/ocr/rec_dyn/recognizer_latin.onnx',
      langList: ['en'],
      useGPU: false
    }
  })
}

// --- Unsupported Image Formats ---

test('getImage rejects GIF format with UNSUPPORTED_IMAGE_FORMAT', { timeout: TEST_TIMEOUT }, async function (t) {
  const onnxOcr = createOcrInstance()
  // GIF magic bytes: GIF89a
  const gifBuffer = Buffer.from([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 0x01, 0x00, 0x01, 0x00, 0x00, 0x00, 0x00])
  const filePath = writeTmpFile('test.gif', gifBuffer)

  try {
    onnxOcr.getImage(filePath)
    t.fail('Should have thrown for GIF format')
  } catch (err) {
    t.ok(err instanceof QvacErrorAddonOcr, 'Should throw QvacErrorAddonOcr')
    t.is(err.code, ERR_CODES.UNSUPPORTED_IMAGE_FORMAT, 'Error code should be UNSUPPORTED_IMAGE_FORMAT')
    t.pass('GIF correctly rejected')
  } finally {
    cleanupTmpDir()
  }
})

test('getImage rejects WebP format with UNSUPPORTED_IMAGE_FORMAT', { timeout: TEST_TIMEOUT }, async function (t) {
  const onnxOcr = createOcrInstance()
  // WebP: RIFF....WEBP
  const webpBuffer = Buffer.alloc(16)
  webpBuffer.write('RIFF', 0)
  webpBuffer.writeUInt32LE(8, 4)
  webpBuffer.write('WEBP', 8)
  const filePath = writeTmpFile('test.webp', webpBuffer)

  try {
    onnxOcr.getImage(filePath)
    t.fail('Should have thrown for WebP format')
  } catch (err) {
    t.ok(err instanceof QvacErrorAddonOcr, 'Should throw QvacErrorAddonOcr')
    t.is(err.code, ERR_CODES.UNSUPPORTED_IMAGE_FORMAT, 'Error code should be UNSUPPORTED_IMAGE_FORMAT')
    t.pass('WebP correctly rejected')
  } finally {
    cleanupTmpDir()
  }
})

test('getImage rejects TIFF format with UNSUPPORTED_IMAGE_FORMAT', { timeout: TEST_TIMEOUT }, async function (t) {
  const onnxOcr = createOcrInstance()
  // TIFF little-endian: II + 42
  const tiffBuffer = Buffer.from([0x49, 0x49, 0x2A, 0x00, 0x08, 0x00, 0x00, 0x00])
  const filePath = writeTmpFile('test.tiff', tiffBuffer)

  try {
    onnxOcr.getImage(filePath)
    t.fail('Should have thrown for TIFF format')
  } catch (err) {
    t.ok(err instanceof QvacErrorAddonOcr, 'Should throw QvacErrorAddonOcr')
    t.is(err.code, ERR_CODES.UNSUPPORTED_IMAGE_FORMAT, 'Error code should be UNSUPPORTED_IMAGE_FORMAT')
    t.pass('TIFF correctly rejected')
  } finally {
    cleanupTmpDir()
  }
})

// --- Corrupt / Invalid Image Files ---

test('getImage rejects zero-byte file', { timeout: TEST_TIMEOUT }, async function (t) {
  const onnxOcr = createOcrInstance()
  const filePath = writeTmpFile('empty.bmp', Buffer.alloc(0))

  try {
    onnxOcr.getImage(filePath)
    t.fail('Should have thrown for zero-byte file')
  } catch (err) {
    t.ok(err instanceof QvacErrorAddonOcr, 'Should throw QvacErrorAddonOcr')
    t.is(err.code, ERR_CODES.INVALID_BMP_OR_INSUFFICIENT_DATA, 'Error code should be INVALID_BMP_OR_INSUFFICIENT_DATA')
    t.pass('Zero-byte file correctly rejected')
  } finally {
    cleanupTmpDir()
  }
})

test('getImage rejects file with less than 4 bytes', { timeout: TEST_TIMEOUT }, async function (t) {
  const onnxOcr = createOcrInstance()
  const filePath = writeTmpFile('tiny.bin', Buffer.from([0x42, 0x4D, 0x01]))

  try {
    onnxOcr.getImage(filePath)
    t.fail('Should have thrown for too-small file')
  } catch (err) {
    t.ok(err instanceof QvacErrorAddonOcr, 'Should throw QvacErrorAddonOcr')
    t.is(err.code, ERR_CODES.INVALID_BMP_OR_INSUFFICIENT_DATA, 'Error code should be INVALID_BMP_OR_INSUFFICIENT_DATA')
    t.pass('Too-small file correctly rejected')
  } finally {
    cleanupTmpDir()
  }
})

test('getImage rejects non-existent file', { timeout: TEST_TIMEOUT }, async function (t) {
  const onnxOcr = createOcrInstance()

  try {
    onnxOcr.getImage('/nonexistent/path/image.bmp')
    t.fail('Should have thrown for non-existent file')
  } catch (err) {
    t.ok(err, 'Should throw an error for non-existent file')
    t.pass('Non-existent file correctly rejected')
  }
})

// --- BMP Parsing Edge Cases ---

test('getImageFromBmp rejects BMP with incomplete header', { timeout: TEST_TIMEOUT }, async function (t) {
  const onnxOcr = createOcrInstance()
  // Valid BMP magic, infoHeaderSize says 40 but buffer is only 24 bytes (< 14 + 40 = 54)
  const buf = Buffer.alloc(24)
  buf[0] = 0x42 // B
  buf[1] = 0x4D // M
  buf.writeUInt32LE(40, 14) // infoHeaderSize = 40
  const filePath = writeTmpFile('incomplete_header.bmp', buf)

  try {
    onnxOcr.getImage(filePath)
    t.fail('Should have thrown for incomplete BMP header')
  } catch (err) {
    t.ok(err instanceof QvacErrorAddonOcr, 'Should throw QvacErrorAddonOcr')
    t.is(err.code, ERR_CODES.INCOMPLETE_BMP_DATA, 'Error code should be INCOMPLETE_BMP_DATA')
    t.pass('Incomplete BMP header correctly rejected')
  } finally {
    cleanupTmpDir()
  }
})

test('getImageFromBmp rejects BMP with unsupported header size', { timeout: TEST_TIMEOUT }, async function (t) {
  const onnxOcr = createOcrInstance()
  // BMP magic + infoHeaderSize of 8 (less than minimum 12), buffer must hold at least 14+8=22 bytes
  const buf = Buffer.alloc(22)
  buf[0] = 0x42
  buf[1] = 0x4D
  buf.writeUInt32LE(8, 14) // infoHeaderSize = 8 (unsupported)
  const filePath = writeTmpFile('bad_header_size.bmp', buf)

  try {
    onnxOcr.getImage(filePath)
    t.fail('Should have thrown for unsupported BMP header size')
  } catch (err) {
    t.ok(err instanceof QvacErrorAddonOcr, 'Should throw QvacErrorAddonOcr')
    t.is(err.code, ERR_CODES.UNSUPPORTED_BMP_HEADER_SIZE, 'Error code should be UNSUPPORTED_BMP_HEADER_SIZE')
    t.pass('Unsupported BMP header size correctly rejected')
  } finally {
    cleanupTmpDir()
  }
})

test('getImageFromBmp rejects BMP with truncated pixel data', { timeout: TEST_TIMEOUT }, async function (t) {
  const onnxOcr = createOcrInstance()
  // Valid BMP header for 10x10 24-bit image, but pixel data is incomplete
  const headerSize = 54
  const buf = Buffer.alloc(headerSize + 10) // way too little pixel data for 10x10
  buf[0] = 0x42 // B
  buf[1] = 0x4D // M
  buf.writeUInt32LE(headerSize, 10) // pixel data offset
  buf.writeUInt32LE(40, 14) // infoHeaderSize (BITMAPINFOHEADER)
  buf.writeInt32LE(10, 18) // width = 10
  buf.writeInt32LE(10, 22) // height = 10
  buf.writeUInt16LE(1, 26) // planes
  buf.writeUInt16LE(24, 28) // bitsPerPixel = 24
  const filePath = writeTmpFile('truncated_pixels.bmp', buf)

  try {
    onnxOcr.getImage(filePath)
    t.fail('Should have thrown for truncated pixel data')
  } catch (err) {
    t.ok(err instanceof QvacErrorAddonOcr, 'Should throw QvacErrorAddonOcr')
    t.is(err.code, ERR_CODES.INVALID_BMP_PIXEL_DATA, 'Error code should be INVALID_BMP_PIXEL_DATA')
    t.pass('Truncated pixel data correctly rejected')
  } finally {
    cleanupTmpDir()
  }
})

test('getImageFromBmp handles negative height (top-down BMP)', { timeout: TEST_TIMEOUT }, async function (t) {
  const onnxOcr = createOcrInstance()
  const width = 2
  const height = -2 // top-down BMP
  const bpp = 24
  const headerSize = 54
  const rowSize = Math.ceil((width * (bpp / 8)) / 4) * 4
  const pixelDataSize = Math.abs(height) * rowSize
  const buf = Buffer.alloc(headerSize + pixelDataSize)

  buf[0] = 0x42
  buf[1] = 0x4D
  buf.writeUInt32LE(headerSize, 10)
  buf.writeUInt32LE(40, 14)
  buf.writeInt32LE(width, 18)
  buf.writeInt32LE(height, 22) // negative height
  buf.writeUInt16LE(1, 26)
  buf.writeUInt16LE(bpp, 28)

  // Fill pixel data with recognizable pattern
  for (let i = headerSize; i < buf.length; i++) {
    buf[i] = i % 256
  }

  const filePath = writeTmpFile('topdown.bmp', buf)

  try {
    const result = onnxOcr.getImage(filePath)
    t.is(result.width, width, 'Width should be 2')
    t.is(result.height, Math.abs(height), 'Height should be absolute value (2)')
    t.ok(result.data, 'Should return pixel data buffer')
    t.ok(result.data.length > 0, 'Pixel data should not be empty')
    t.pass('Top-down BMP (negative height) parsed successfully')
  } finally {
    cleanupTmpDir()
  }
})

test('getImage correctly detects JPEG by magic bytes', { timeout: TEST_TIMEOUT }, async function (t) {
  const onnxOcr = createOcrInstance()
  // JPEG magic: 0xFF 0xD8
  const jpegBuffer = Buffer.alloc(16)
  jpegBuffer[0] = 0xFF
  jpegBuffer[1] = 0xD8
  jpegBuffer[2] = 0xFF
  jpegBuffer[3] = 0xE0
  const filePath = writeTmpFile('test.jpg', jpegBuffer)

  try {
    const result = onnxOcr.getImage(filePath)
    t.ok(result.isEncoded, 'JPEG should be marked as encoded (for C++ decoding)')
    t.ok(result.data, 'Should contain the raw file data')
    t.pass('JPEG magic bytes correctly detected')
  } finally {
    cleanupTmpDir()
  }
})

test('getImage correctly detects PNG by magic bytes', { timeout: TEST_TIMEOUT }, async function (t) {
  const onnxOcr = createOcrInstance()
  // PNG magic: 0x89 0x50 0x4E 0x47
  const pngBuffer = Buffer.alloc(16)
  pngBuffer[0] = 0x89
  pngBuffer[1] = 0x50
  pngBuffer[2] = 0x4E
  pngBuffer[3] = 0x47
  const filePath = writeTmpFile('test.png', pngBuffer)

  try {
    const result = onnxOcr.getImage(filePath)
    t.ok(result.isEncoded, 'PNG should be marked as encoded (for C++ decoding)')
    t.ok(result.data, 'Should contain the raw file data')
    t.pass('PNG magic bytes correctly detected')
  } finally {
    cleanupTmpDir()
  }
})

// --- Language Handling Errors ---

test('getRecognizerModelName throws for completely unsupported language list', { timeout: TEST_TIMEOUT }, async function (t) {
  const onnxOcr = createOcrInstance()

  try {
    onnxOcr.getRecognizerModelName(['klingon', 'elvish'])
    t.fail('Should have thrown for unsupported languages')
  } catch (err) {
    t.ok(err instanceof QvacErrorAddonOcr, 'Should throw QvacErrorAddonOcr')
    t.is(err.code, ERR_CODES.UNSUPPORTED_LANGUAGE, 'Error code should be UNSUPPORTED_LANGUAGE')
    t.pass('Unsupported language list correctly rejected')
  }
})

test('getRecognizerModelName throws for empty language list', { timeout: TEST_TIMEOUT }, async function (t) {
  const onnxOcr = createOcrInstance()

  try {
    onnxOcr.getRecognizerModelName([])
    t.fail('Should have thrown for empty language list')
  } catch (err) {
    t.ok(err instanceof QvacErrorAddonOcr, 'Should throw QvacErrorAddonOcr')
    t.is(err.code, ERR_CODES.UNSUPPORTED_LANGUAGE, 'Error code should be UNSUPPORTED_LANGUAGE')
    t.pass('Empty language list correctly rejected')
  }
})

test('getRecognizerModelName returns latin for English', { timeout: TEST_TIMEOUT }, async function (t) {
  const onnxOcr = createOcrInstance()
  const result = onnxOcr.getRecognizerModelName(['en'])
  t.is(result, 'latin', 'English should map to latin recognizer')
})

test('getRecognizerModelName returns arabic for Arabic', { timeout: TEST_TIMEOUT }, async function (t) {
  const onnxOcr = createOcrInstance()
  const result = onnxOcr.getRecognizerModelName(['ar'])
  t.is(result, 'arabic', 'Arabic should map to arabic recognizer')
})

test('getRecognizerModelName returns cyrillic for Russian', { timeout: TEST_TIMEOUT }, async function (t) {
  const onnxOcr = createOcrInstance()
  const result = onnxOcr.getRecognizerModelName(['ru'])
  t.is(result, 'cyrillic', 'Russian should map to cyrillic recognizer')
})

test('getRecognizerModelName returns devanagari for Hindi', { timeout: TEST_TIMEOUT }, async function (t) {
  const onnxOcr = createOcrInstance()
  const result = onnxOcr.getRecognizerModelName(['hi'])
  t.is(result, 'devanagari', 'Hindi should map to devanagari recognizer')
})

test('getRecognizerModelName returns bengali for Bengali', { timeout: TEST_TIMEOUT }, async function (t) {
  const onnxOcr = createOcrInstance()
  const result = onnxOcr.getRecognizerModelName(['bn'])
  t.is(result, 'bengali', 'Bengali should map to bengali recognizer')
})

test('getRecognizerModelName prioritizes first language in list', { timeout: TEST_TIMEOUT }, async function (t) {
  const onnxOcr = createOcrInstance()
  const result = onnxOcr.getRecognizerModelName(['ar', 'en'])
  t.is(result, 'arabic', 'Should use first supported language (arabic) not second (latin)')
})

test('getRecognizerModelName handles other script languages', { timeout: TEST_TIMEOUT }, async function (t) {
  const onnxOcr = createOcrInstance()

  t.is(onnxOcr.getRecognizerModelName(['ja']), 'japanese', 'Japanese should map correctly')
  t.is(onnxOcr.getRecognizerModelName(['ko']), 'korean', 'Korean should map correctly')
  t.is(onnxOcr.getRecognizerModelName(['th']), 'thai', 'Thai should map correctly')
  t.is(onnxOcr.getRecognizerModelName(['ta']), 'tamil', 'Tamil should map correctly')
  t.is(onnxOcr.getRecognizerModelName(['te']), 'telugu', 'Telugu should map correctly')
  t.is(onnxOcr.getRecognizerModelName(['kn']), 'kannada', 'Kannada should map correctly')
  t.is(onnxOcr.getRecognizerModelName(['ch_sim']), 'zh_sim', 'Chinese simplified should map correctly')
  t.is(onnxOcr.getRecognizerModelName(['ch_tra']), 'zh_tra', 'Chinese traditional should map correctly')
})
