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

// ---------- LoRA path validation ----------

test('run | throws when lora is an empty string', async (t) => {
  const model = new ImgStableDiffusion({
    files: {
      model: '/tmp/stable-diffusion-v2-1-Q4_0.gguf'
    },
    config: { threads: 1 },
    logger: console
  })

  try {
    await model.run({ prompt: 'test', lora: '' })
    t.fail('should have thrown')
  } catch (err) {
    t.ok(err instanceof TypeError, 'throws TypeError')
    t.ok(
      /params\.lora must be a non-empty string/.test(err.message),
      'error message explains lora must be non-empty'
    )
  }
})

test('run | throws when lora is not a string', async (t) => {
  const model = new ImgStableDiffusion({
    files: {
      model: '/tmp/stable-diffusion-v2-1-Q4_0.gguf'
    },
    config: { threads: 1 },
    logger: console
  })

  try {
    await model.run({ prompt: 'test', lora: 42 })
    t.fail('should have thrown')
  } catch (err) {
    t.ok(err instanceof TypeError, 'throws TypeError')
    t.ok(
      /params\.lora must be a non-empty string/.test(err.message),
      'error message explains lora must be a string'
    )
  }
})

test('run | throws when lora is a relative path', async (t) => {
  const model = new ImgStableDiffusion({
    files: {
      model: '/tmp/stable-diffusion-v2-1-Q4_0.gguf'
    },
    config: { threads: 1 },
    logger: console
  })

  try {
    await model.run({ prompt: 'test', lora: 'adapter.safetensors' })
    t.fail('should have thrown')
  } catch (err) {
    t.ok(err instanceof TypeError, 'throws TypeError')
    t.ok(
      /params\.lora must be an absolute path/.test(err.message),
      'error message explains lora must be absolute'
    )
  }
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

// ---------- init_images (multi-reference "fusion") guards ----------

test('init_images | rejects combining init_image + init_images', async (t) => {
  const model = new ImgStableDiffusion({
    files: {
      model: '/tmp/flux-2-klein-4b-Q8_0.gguf',
      llm: '/tmp/Qwen3-4B-Q4_K_M.gguf'
    },
    config: { threads: 1, prediction: 'flux2_flow' },
    logger: console
  })

  try {
    await model.run({
      prompt: 'test @image1',
      init_image: VALID_PNG_HEADER,
      init_images: [VALID_PNG_HEADER, VALID_JPEG_HEADER]
    })
    t.fail('should have thrown')
  } catch (err) {
    t.ok(
      /mutually exclusive/.test(err.message),
      'error mentions mutual exclusion'
    )
  }
})

test('init_images | rejects non-FLUX.2 model (no files.llm)', async (t) => {
  const model = new ImgStableDiffusion({
    files: {
      model: '/tmp/stable-diffusion-v2-1-Q4_0.gguf'
    },
    config: { threads: 1 },
    logger: console
  })

  try {
    await model.run({
      prompt: 'test @image1 @image2',
      init_images: [VALID_PNG_HEADER, VALID_JPEG_HEADER]
    })
    t.fail('should have thrown')
  } catch (err) {
    t.ok(
      /multi-reference fusion\) requires a FLUX\.2 model/.test(err.message),
      'error mentions FLUX.2 requirement'
    )
  }
})

test('init_images | rejects FLUX.2 model without prediction=flux2_flow', async (t) => {
  const model = new ImgStableDiffusion({
    files: {
      model: '/tmp/flux-2-klein-4b-Q8_0.gguf',
      llm: '/tmp/Qwen3-4B-Q4_K_M.gguf'
    },
    config: { threads: 1 /* no prediction */ },
    logger: console
  })

  try {
    await model.run({
      prompt: 'test @image1 @image2',
      init_images: [VALID_PNG_HEADER, VALID_JPEG_HEADER]
    })
    t.fail('should have thrown')
  } catch (err) {
    t.ok(
      /multi-reference fusion\) requires a FLUX\.2 model/.test(err.message),
      'error message mentions FLUX.2 / fusion'
    )
  }
})

test('init_images | rejects non-Uint8Array entries', async (t) => {
  const model = new ImgStableDiffusion({
    files: {
      model: '/tmp/flux-2-klein-4b-Q8_0.gguf',
      llm: '/tmp/Qwen3-4B-Q4_K_M.gguf'
    },
    config: { threads: 1, prediction: 'flux2_flow' },
    logger: console
  })

  try {
    await model.run({
      prompt: 'test @image1 @image2',
      init_images: [VALID_PNG_HEADER, 'not-a-buffer']
    })
    t.fail('should have thrown')
  } catch (err) {
    t.ok(
      /init_images\[1\] must be a non-empty Uint8Array/.test(err.message),
      'error names the offending index'
    )
  }
})

test('init_images | rejects empty Uint8Array entry', async (t) => {
  const model = new ImgStableDiffusion({
    files: {
      model: '/tmp/flux-2-klein-4b-Q8_0.gguf',
      llm: '/tmp/Qwen3-4B-Q4_K_M.gguf'
    },
    config: { threads: 1, prediction: 'flux2_flow' },
    logger: console
  })

  try {
    await model.run({
      prompt: 'test @image1 @image2',
      init_images: [VALID_PNG_HEADER, new Uint8Array(0)]
    })
    t.fail('should have thrown')
  } catch (err) {
    t.ok(
      /init_images\[1\] must be a non-empty Uint8Array/.test(err.message),
      'error rejects empty buffer'
    )
  }
})

test('init_images | warns when prompt is missing all @imageN placeholders', async (t) => {
  const warnings = []
  const logger = {
    error: () => {},
    warn: (msg) => warnings.push(msg),
    info: () => {},
    debug: () => {}
  }

  const model = new ImgStableDiffusion({
    files: {
      model: '/tmp/flux-2-klein-4b-Q8_0.gguf',
      llm: '/tmp/Qwen3-4B-Q4_K_M.gguf'
    },
    config: { threads: 1, prediction: 'flux2_flow' },
    logger
  })

  try {
    // Prompt references NONE of @image1, @image2 — warn, don't throw.
    await model.run({
      prompt: 'just a plain prompt with no references',
      init_images: [VALID_PNG_HEADER, VALID_JPEG_HEADER]
    })
  } catch (_err) {
    // will fail later because the model isn't actually loaded — that's fine.
  }

  t.ok(
    warnings.some((w) => /If multiple images have been selected/.test(String(w))),
    'logs the @imageN prompt-check warning'
  )
})

test('init_images | warns when prompt references only some @imageN', async (t) => {
  const warnings = []
  const logger = {
    error: () => {},
    warn: (msg) => warnings.push(msg),
    info: () => {},
    debug: () => {}
  }

  const model = new ImgStableDiffusion({
    files: {
      model: '/tmp/flux-2-klein-4b-Q8_0.gguf',
      llm: '/tmp/Qwen3-4B-Q4_K_M.gguf'
    },
    config: { threads: 1, prediction: 'flux2_flow' },
    logger
  })

  try {
    await model.run({
      prompt: 'mix of @image1 only, nothing else',
      init_images: [VALID_PNG_HEADER, VALID_JPEG_HEADER]
    })
  } catch (_err) {
    // expected — no model loaded
  }

  t.ok(
    warnings.some((w) => /missing @image2/.test(String(w))),
    'logs a "missing @image2" warning when only some refs are mentioned'
  )
})

test('init_images | logs "fusion" mode info message', async (t) => {
  const infos = []
  const logger = {
    error: () => {},
    warn: () => {},
    info: (msg) => infos.push(msg),
    debug: () => {}
  }

  const model = new ImgStableDiffusion({
    files: {
      model: '/tmp/flux-2-klein-4b-Q8_0.gguf',
      llm: '/tmp/Qwen3-4B-Q4_K_M.gguf'
    },
    config: { threads: 1, prediction: 'flux2_flow' },
    logger
  })

  try {
    await model.run({
      prompt: '@image1 and @image2 fused',
      init_images: [VALID_PNG_HEADER, VALID_JPEG_HEADER]
    })
  } catch (_err) {
    // expected — no model loaded
  }

  t.ok(
    infos.some((m) => /entering "fusion" mode/.test(String(m))),
    'addon notifies the user that SD is entering fusion mode'
  )
})

test('init_image | still works on FLUX.2 (regression — single-image path unchanged)', async (t) => {
  const model = new ImgStableDiffusion({
    files: {
      model: '/tmp/flux-2-klein-4b-Q8_0.gguf',
      llm: '/tmp/Qwen3-4B-Q4_K_M.gguf'
    },
    config: { threads: 1, prediction: 'flux2_flow' },
    logger: console
  })

  // Single-image path must NOT trigger any of the new init_images errors.
  try {
    await model.run({ prompt: 'test', init_image: VALID_PNG_HEADER })
    t.fail('should have thrown (no model loaded)')
  } catch (err) {
    t.absent(
      /mutually exclusive/.test(err.message),
      'single init_image does not trip the mutual-exclusion guard'
    )
    t.absent(
      /multi-reference fusion/.test(err.message),
      'single init_image does not trip the fusion/FLUX.2 guard'
    )
  }
})
