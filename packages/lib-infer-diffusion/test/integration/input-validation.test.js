'use strict'

const test = require('brittle')
const ImgStableDiffusion = require('../../index')
const { readImageDimensions } = require('../../addon')

// ---------- Minimal PNG/JPEG fixtures (valid headers, no real pixel data) ----------

// Valid 24-byte PNG header: magic (8) + IHDR length (4) + "IHDR" (4) + width 64 (4) + height 48 (4)
const VALID_PNG_HEADER = new Uint8Array([
  0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, // magic
  0x00, 0x00, 0x00, 0x0D, // IHDR chunk length
  0x49, 0x48, 0x44, 0x52, // "IHDR"
  0x00, 0x00, 0x00, 0x40, // width = 64
  0x00, 0x00, 0x00, 0x30 // height = 48
])

// Valid JPEG with SOF0 segment: FFD8 + FF C0 + segLen=0011 + precision + height 96 + width 128
const VALID_JPEG_HEADER = new Uint8Array([
  0xFF, 0xD8, // SOI
  0xFF, 0xC0, // SOF0
  0x00, 0x11, // segment length = 17
  0x08, // precision
  0x00, 0x60, // height = 96
  0x00, 0x80 // width = 128
])

// ---------- readImageDimensions: valid inputs ----------

test('readImageDimensions | valid PNG header returns correct dimensions', async (t) => {
  const dims = readImageDimensions(VALID_PNG_HEADER)
  t.ok(dims, 'returns non-null for valid PNG')
  t.is(dims.width, 64, 'PNG width = 64')
  t.is(dims.height, 48, 'PNG height = 48')
})

test('readImageDimensions | valid JPEG header returns correct dimensions', async (t) => {
  const dims = readImageDimensions(VALID_JPEG_HEADER)
  t.ok(dims, 'returns non-null for valid JPEG')
  t.is(dims.width, 128, 'JPEG width = 128')
  t.is(dims.height, 96, 'JPEG height = 96')
})

// ---------- readImageDimensions: truncated / corrupt inputs ----------

test('readImageDimensions | null / empty buffer returns null', async (t) => {
  t.is(readImageDimensions(null), null, 'null buffer')
  t.is(readImageDimensions(new Uint8Array(0)), null, 'empty buffer')
  t.is(readImageDimensions(new Uint8Array(3)), null, 'buffer shorter than 4 bytes')
})

test('readImageDimensions | truncated PNG (magic only) returns null', async (t) => {
  const truncated = VALID_PNG_HEADER.slice(0, 8)
  t.is(readImageDimensions(truncated), null, 'PNG with only magic bytes returns null')
})

test('readImageDimensions | truncated PNG (23 bytes — one short of IHDR) returns null', async (t) => {
  const truncated = VALID_PNG_HEADER.slice(0, 23)
  t.is(readImageDimensions(truncated), null, 'PNG truncated at 23 bytes returns null')
})

test('readImageDimensions | truncated JPEG (SOI only) returns null', async (t) => {
  const truncated = new Uint8Array([0xFF, 0xD8])
  t.is(readImageDimensions(truncated), null, 'JPEG with only SOI returns null')
})

test('readImageDimensions | truncated JPEG (SOF marker but missing dimension bytes) returns null', async (t) => {
  // SOI + SOF0 marker + segment length, but body truncated before height/width
  const truncated = VALID_JPEG_HEADER.slice(0, 7)
  t.is(readImageDimensions(truncated), null, 'JPEG truncated mid-SOF returns null')
})

test('readImageDimensions | JPEG with zero segment length returns null', async (t) => {
  const badSegLen = new Uint8Array([
    0xFF, 0xD8,
    0xFF, 0xE0,
    0x00, 0x00 // segLen = 0 (invalid, minimum is 2)
  ])
  t.is(readImageDimensions(badSegLen), null, 'JPEG with segLen=0 returns null')
})

test('readImageDimensions | unrecognised format returns null', async (t) => {
  const gif = new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61])
  t.is(readImageDimensions(gif), null, 'GIF buffer returns null')
})

// ---------- FLUX img2img prediction guard ----------

test('FLUX img2img | throws when prediction is omitted', async (t) => {
  const model = new ImgStableDiffusion({
    files: {
      model: '/tmp/flux-2-klein-4b-Q8_0.gguf',
      llm: '/tmp/Qwen3-4B-Q4_K_M.gguf'
    },
    config: { threads: 1 },
    logger: console
  })

  const fakeImage = VALID_PNG_HEADER

  try {
    await model.run({ prompt: 'test', init_image: fakeImage })
    t.fail('should have thrown')
  } catch (err) {
    t.ok(
      /FLUX img2img requires an explicit prediction type/.test(err.message),
      'error message mentions FLUX prediction requirement'
    )
    t.ok(
      /flux2_flow/.test(err.message),
      'error message suggests flux2_flow'
    )
  }
})

test('FLUX img2img | throws when prediction is "auto"', async (t) => {
  const model = new ImgStableDiffusion({
    files: {
      model: '/tmp/flux-2-klein-4b-Q8_0.gguf',
      llm: '/tmp/Qwen3-4B-Q4_K_M.gguf'
    },
    config: { threads: 1, prediction: 'auto' },
    logger: console
  })

  const fakeImage = VALID_PNG_HEADER

  try {
    await model.run({ prompt: 'test', init_image: fakeImage })
    t.fail('should have thrown')
  } catch (err) {
    t.ok(
      /FLUX img2img requires an explicit prediction type/.test(err.message),
      'prediction: "auto" is rejected for FLUX img2img'
    )
  }
})

test('FLUX img2img | does NOT throw for txt2img even without prediction', async (t) => {
  const model = new ImgStableDiffusion({
    files: {
      model: '/tmp/flux-2-klein-4b-Q8_0.gguf',
      llm: '/tmp/Qwen3-4B-Q4_K_M.gguf'
    },
    config: { threads: 1 },
    logger: console
  })

  // txt2img (no init_image) should pass the guard even without prediction.
  // It will fail later because no model is loaded, but that's expected —
  // the guard itself must not fire.
  try {
    await model.run({ prompt: 'test' })
    t.fail('should have thrown (no model loaded)')
  } catch (err) {
    t.absent(
      /FLUX img2img requires/.test(err.message),
      'txt2img does not trigger the FLUX prediction guard'
    )
  }
})

test('non-FLUX model | does NOT throw for img2img without prediction', async (t) => {
  const model = new ImgStableDiffusion({
    files: {
      model: '/tmp/stable-diffusion-v2-1-Q4_0.gguf'
    },
    config: { threads: 1 },
    logger: console
  })

  // SD model (no files.llm) should not trigger the FLUX guard.
  try {
    await model.run({ prompt: 'test', init_image: VALID_PNG_HEADER })
    t.fail('should have thrown (no model loaded)')
  } catch (err) {
    t.absent(
      /FLUX img2img requires/.test(err.message),
      'non-FLUX model does not trigger the FLUX prediction guard'
    )
  }
})
