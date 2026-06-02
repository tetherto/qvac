'use strict'

// Unit tests for VideoStableDiffusion JS-side input validation.
//
// These tests deliberately exercise paths that throw BEFORE any native
// addon load happens, so they don't need a working build/prebuild and
// run in milliseconds. End-to-end Wan generation is covered by the
// opt-in integration test at test/integration/generate-video-wan.test.js.

const test = require('brittle')
const VideoStableDiffusion = require('../../video')

const FAKE_MODEL = '/tmp/wan2.1_t2v_1.3B_fp16.safetensors'
const FAKE_T5XXL = '/tmp/umt5_xxl_fp16.safetensors'
const FAKE_VAE = '/tmp/wan_2.1_vae.safetensors'
const FAKE_HIGH_NOISE = '/tmp/wan2.2_t2v_high_noise.safetensors'
const FAKE_CLIP_VISION = '/tmp/clip_vision_h.safetensors'

// Minimal valid PNG header (24 bytes — magic + IHDR width/height).
const FAKE_PNG = new Uint8Array([
  0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A,
  0x00, 0x00, 0x00, 0x0D,
  0x49, 0x48, 0x44, 0x52,
  0x00, 0x00, 0x00, 0x40,
  0x00, 0x00, 0x00, 0x30
])

const FAKE_JPEG = new Uint8Array([
  0xFF, 0xD8, 0xFF, 0xC0, 0x00, 0x11, 0x08,
  0x00, 0x60, 0x00, 0x80
])

function makeQuiet () {
  return {
    error: () => {},
    warn: () => {},
    info: () => {},
    debug: () => {}
  }
}

function makeRecording () {
  const events = { error: [], warn: [], info: [], debug: [] }
  return {
    events,
    logger: {
      error: (msg) => events.error.push(String(msg)),
      warn: (msg) => events.warn.push(String(msg)),
      info: (msg) => events.info.push(String(msg)),
      debug: (msg) => events.debug.push(String(msg))
    }
  }
}

function makeWanModel ({ files, config, logger } = {}) {
  return new VideoStableDiffusion({
    files: files || {
      model: FAKE_MODEL,
      t5Xxl: FAKE_T5XXL,
      vae: FAKE_VAE,
      clipVision: FAKE_CLIP_VISION
    },
    config: config || { threads: 1 },
    logger: logger || makeQuiet()
  })
}

// ─────────────────────────────────────────────────────────────────────
//  Constructor: files validation
// ─────────────────────────────────────────────────────────────────────

test('ctor | throws when files is missing', async (t) => {
  await t.exception.all(
    () => new VideoStableDiffusion({}),
    /files must be an object containing at least { model }/
  )
})

test('ctor | throws when files is not an object', async (t) => {
  await t.exception.all(
    () => new VideoStableDiffusion({ files: 'not-an-object' }),
    /files must be an object/
  )
})

test('ctor | throws when files.model is missing', async (t) => {
  await t.exception.all(
    () => new VideoStableDiffusion({ files: { t5Xxl: FAKE_T5XXL } }),
    /files\.model must be an absolute path string/
  )
})

test('ctor | throws when files.model is empty string', async (t) => {
  await t.exception.all(
    () => new VideoStableDiffusion({ files: { model: '' } }),
    /files\.model must be an absolute path string/
  )
})

test('ctor | throws when files.model is a relative path', async (t) => {
  await t.exception.all(
    () => new VideoStableDiffusion({ files: { model: 'wan2.1.safetensors' } }),
    /files\.model must be an absolute path/
  )
})

test('ctor | throws when files.t5Xxl is a relative path', async (t) => {
  await t.exception.all(
    () => new VideoStableDiffusion({
      files: { model: FAKE_MODEL, t5Xxl: 'umt5.safetensors' }
    }),
    /files\.t5Xxl must be an absolute path/
  )
})

test('ctor | throws when files.vae is a relative path', async (t) => {
  await t.exception.all(
    () => new VideoStableDiffusion({
      files: { model: FAKE_MODEL, vae: 'vae.safetensors' }
    }),
    /files\.vae must be an absolute path/
  )
})

test('ctor | throws when files.highNoiseDiffusionModel is a relative path', async (t) => {
  await t.exception.all(
    () => new VideoStableDiffusion({
      files: { model: FAKE_MODEL, highNoiseDiffusionModel: 'high.safetensors' }
    }),
    /files\.highNoiseDiffusionModel must be an absolute path/
  )
})

test('ctor | accepts a Wan 2.1 file set (single expert)', async (t) => {
  const m = makeWanModel()
  t.is(m.getState().configLoaded, false, 'state.configLoaded starts false')
  t.is(typeof m.run, 'function', 'instance has .run()')
  t.is(typeof m.load, 'function', 'instance has .load()')
  t.is(typeof m.unload, 'function', 'instance has .unload()')
  t.is(typeof m.cancel, 'function', 'instance has .cancel()')
})

test('ctor | accepts a Wan 2.2 file set (with high-noise expert)', async (t) => {
  const m = new VideoStableDiffusion({
    files: {
      model: FAKE_MODEL,
      highNoiseDiffusionModel: FAKE_HIGH_NOISE,
      t5Xxl: FAKE_T5XXL,
      vae: FAKE_VAE
    },
    config: { threads: 1 },
    logger: makeQuiet()
  })
  t.is(m.getState().configLoaded, false)
})

// ─────────────────────────────────────────────────────────────────────
//  run(): mode validation
// ─────────────────────────────────────────────────────────────────────

test('run | throws when params is missing', async (t) => {
  const m = makeWanModel()
  await t.exception.all(m.run(), /params must be an object/)
})

test('run | throws when params is not an object', async (t) => {
  const m = makeWanModel()
  await t.exception.all(m.run('not-an-object'), /params must be an object/)
})

test('run | throws when mode is missing', async (t) => {
  const m = makeWanModel()
  await t.exception.all(m.run({ prompt: 'hi' }), /params\.mode is required/)
})

test('run | throws when mode is not a string', async (t) => {
  const m = makeWanModel()
  await t.exception.all(m.run({ mode: 42, prompt: 'hi' }), /params\.mode is required/)
})

test('run | throws when mode is an unrecognised string', async (t) => {
  const m = makeWanModel()
  await t.exception.all(m.run({ mode: 'txt2img', prompt: 'hi' }), /'txt2vid' \| 'img2vid'/)
})

// ─────────────────────────────────────────────────────────────────────
//  run(): dimension alignment
// ─────────────────────────────────────────────────────────────────────

test('run | throws when width is not a multiple of 16', async (t) => {
  const m = makeWanModel()
  await t.exception.all(
    m.run({ mode: 'txt2vid', prompt: 'hi', width: 833, height: 480 }),
    /width and height must be positive multiples of 16/
  )
})

test('run | throws when height is not a multiple of 16', async (t) => {
  const m = makeWanModel()
  await t.exception.all(
    m.run({ mode: 'txt2vid', prompt: 'hi', width: 832, height: 481 }),
    /width and height must be positive multiples of 16/
  )
})

test('run | width=NaN is rejected (treated as misaligned)', async (t) => {
  const m = makeWanModel()
  await t.exception.all(
    m.run({ mode: 'txt2vid', prompt: 'hi', width: Number.NaN }),
    /multiples of 16/
  )
})

test('run | suggests a nearby valid pair in the error message', async (t) => {
  const m = makeWanModel()
  await t.exception.all(
    m.run({ mode: 'txt2vid', prompt: 'hi', width: 833, height: 481 }),
    /Use 832x480 instead/
  )
})

test('run | width/height omitted is allowed (C++ defaults to 480x832)', async (t) => {
  const m = makeWanModel()
  // Validation passes; addon-not-loaded throws afterwards.
  await t.exception.all(
    m.run({ mode: 'txt2vid', prompt: 'hi' }),
    /Addon not initialized/
  )
})

// ─────────────────────────────────────────────────────────────────────
//  run(): prompt is required
//  JSDoc declares params.prompt as Required, but it was never type-checked
//  -- `prompt: undefined` got JSON.stringify'd away and the C++ default
//  empty string produced silent noise output. These tests pin down the
//  loud TypeError that now fires at the JS boundary for all bad shapes.
// ─────────────────────────────────────────────────────────────────────

test('run | rejects missing prompt', async (t) => {
  const m = makeWanModel()
  await t.exception.all(
    m.run({ mode: 'txt2vid' }),
    /params\.prompt is required and must be a non-empty string/
  )
})

test('run | rejects empty-string prompt', async (t) => {
  const m = makeWanModel()
  await t.exception.all(
    m.run({ mode: 'txt2vid', prompt: '' }),
    /params\.prompt is required and must be a non-empty string/
  )
})

test('run | rejects non-string prompt (number)', async (t) => {
  const m = makeWanModel()
  await t.exception.all(
    m.run({ mode: 'txt2vid', prompt: 42 }),
    /params\.prompt is required and must be a non-empty string/
  )
})

test('run | rejects null prompt', async (t) => {
  const m = makeWanModel()
  await t.exception.all(
    m.run({ mode: 'txt2vid', prompt: null }),
    /params\.prompt is required and must be a non-empty string/
  )
})

// ─────────────────────────────────────────────────────────────────────
//  run(): off-grid init/end/control frames are rejected when the caller
//         relies on implicit-dim inference (no explicit width/height).
//
//  Background: addon.js _fillDimsFromImage previously did
//  `Math.ceil(d/8)*8` -- so a 100x100 init_image got dispatched as
//  104x104, and the native processVideo dimension check then threw
//  citing 104x104 (a value the caller never passed). Now addon.js
//  passes dims through verbatim, and this layer pre-empts the cryptic
//  native error with a clear "your image is off-grid, pre-align or
//  pass explicit dims" message.
// ─────────────────────────────────────────────────────────────────────

// 100x100 PNG header -- both axes off the multiple-of-16 grid.
const OFFGRID_PNG = new Uint8Array([
  0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A,
  0x00, 0x00, 0x00, 0x0D,
  0x49, 0x48, 0x44, 0x52,
  0x00, 0x00, 0x00, 0x64, // width = 100
  0x00, 0x00, 0x00, 0x64 // height = 100
])

test('run | rejects off-grid init_image when width/height are implicit', async (t) => {
  const m = makeWanModel()
  await t.exception.all(
    m.run({ mode: 'img2vid', prompt: 'hi', init_image: OFFGRID_PNG }),
    /init_image dimensions 100x100 must be multiples of 16/
  )
})

test('run | rejects off-grid control_frames[i] with index when dims implicit', async (t) => {
  const m = makeWanModel()
  await t.exception.all(
    m.run({
      mode: 'txt2vid',
      prompt: 'hi',
      control_frames: [FAKE_PNG, OFFGRID_PNG, FAKE_JPEG]
    }),
    /control_frames\[1\] dimensions 100x100 must be multiples of 16/
  )
})

test('run | accepts off-grid init_image when caller passes explicit aligned width/height', async (t) => {
  // Caller is asserting "yes I know the image is 100x100, please render
  // 104x104 video -- I'll handle alignment myself." The probe must NOT
  // fire when width/height are explicit; the strict native check still
  // catches a mismatched explicit dim downstream.
  const m = makeWanModel()
  await t.exception.all(
    m.run({
      mode: 'img2vid',
      prompt: 'hi',
      init_image: OFFGRID_PNG,
      width: 112,
      height: 112
    }),
    /Addon not initialized/
  )
})

// ─────────────────────────────────────────────────────────────────────
//  run(): video_frames (4*k + 1 rule)
// ─────────────────────────────────────────────────────────────────────

test('run | rejects video_frames < 5', async (t) => {
  const m = makeWanModel()
  await t.exception.all(
    m.run({ mode: 'txt2vid', prompt: 'hi', video_frames: 1 }),
    /video_frames.*\(4\*k \+ 1\)/
  )
})

test('run | rejects video_frames not of the form 4k+1', async (t) => {
  const m = makeWanModel()
  for (const bad of [4, 6, 8, 10, 16, 32, 34, 36]) {
    await t.exception.all(
      m.run({ mode: 'txt2vid', prompt: 'hi', video_frames: bad }),
      /4\*k \+ 1/,
      `video_frames=${bad} is rejected`
    )
  }
})

test('run | accepts video_frames of the form 4k+1', async (t) => {
  const m = makeWanModel()
  for (const ok of [5, 9, 13, 17, 21, 25, 29, 33, 37, 41, 45, 81]) {
    await t.exception.all(
      m.run({ mode: 'txt2vid', prompt: 'hi', video_frames: ok }),
      /Addon not initialized/,
      `video_frames=${ok} passes validation`
    )
  }
})

test('run | rejects non-numeric video_frames', async (t) => {
  const m = makeWanModel()
  await t.exception.all(
    m.run({ mode: 'txt2vid', prompt: 'hi', video_frames: 'thirty-three' }),
    /video_frames must be an integer/
  )
})

test('run | rejects Infinity for video_frames', async (t) => {
  const m = makeWanModel()
  await t.exception.all(
    m.run({ mode: 'txt2vid', prompt: 'hi', video_frames: Infinity }),
    /video_frames must be an integer/
  )
})

// ─────────────────────────────────────────────────────────────────────
//  run(): fps range
// ─────────────────────────────────────────────────────────────────────

test('run | rejects fps <= 0', async (t) => {
  const m = makeWanModel()
  await t.exception.all(
    m.run({ mode: 'txt2vid', prompt: 'hi', fps: 0 }),
    /fps must be in \(0, 120\]/
  )
})

test('run | rejects negative fps', async (t) => {
  const m = makeWanModel()
  await t.exception.all(
    m.run({ mode: 'txt2vid', prompt: 'hi', fps: -16 }),
    /fps must be in \(0, 120\]/
  )
})

test('run | rejects fps > 120', async (t) => {
  const m = makeWanModel()
  await t.exception.all(
    m.run({ mode: 'txt2vid', prompt: 'hi', fps: 240 }),
    /fps must be in \(0, 120\]/
  )
})

test('run | rejects non-finite fps', async (t) => {
  const m = makeWanModel()
  await t.exception.all(
    m.run({ mode: 'txt2vid', prompt: 'hi', fps: Number.POSITIVE_INFINITY }),
    /fps must be in/
  )
})

// ─────────────────────────────────────────────────────────────────────
//  run(): moe_boundary range (Wan 2.2)
// ─────────────────────────────────────────────────────────────────────

test('run | rejects moe_boundary < 0', async (t) => {
  const m = makeWanModel()
  await t.exception.all(
    m.run({ mode: 'txt2vid', prompt: 'hi', moe_boundary: -0.1 }),
    /moe_boundary must be in \[0, 1\]/
  )
})

test('run | rejects moe_boundary > 1', async (t) => {
  const m = makeWanModel()
  await t.exception.all(
    m.run({ mode: 'txt2vid', prompt: 'hi', moe_boundary: 1.5 }),
    /moe_boundary must be in \[0, 1\]/
  )
})

test('run | accepts moe_boundary at the endpoints (0 and 1)', async (t) => {
  const m = makeWanModel()
  for (const b of [0, 0.0, 0.5, 1.0, 1]) {
    await t.exception.all(
      m.run({ mode: 'txt2vid', prompt: 'hi', moe_boundary: b }),
      /Addon not initialized/,
      `moe_boundary=${b} passes validation`
    )
  }
})

// ─────────────────────────────────────────────────────────────────────
//  run(): init_image
// ─────────────────────────────────────────────────────────────────────

test('run | rejects non-Uint8Array init_image', async (t) => {
  const m = makeWanModel()
  await t.exception.all(
    m.run({ mode: 'img2vid', prompt: 'hi', init_image: 'string-not-buffer' }),
    /init_image must be a Uint8Array/
  )
})

test('run | rejects empty init_image buffer', async (t) => {
  const m = makeWanModel()
  await t.exception.all(
    m.run({ mode: 'img2vid', prompt: 'hi', init_image: new Uint8Array(0) }),
    /init_image must not be empty/
  )
})

// ─────────────────────────────────────────────────────────────────────
//  run(): init_images is rejected (image-only feature)
// ─────────────────────────────────────────────────────────────────────

test('run | rejects init_images (FLUX fusion is image-only)', async (t) => {
  const m = makeWanModel()
  await t.exception.all(
    m.run({ mode: 'txt2vid', prompt: 'hi', init_images: [FAKE_PNG, FAKE_JPEG] }),
    /VideoStableDiffusion does not accept init_images/
  )
})

// ─────────────────────────────────────────────────────────────────────
//  run(): mode-vs-input invariants
// ─────────────────────────────────────────────────────────────────────

test('run | txt2vid rejects init_image', async (t) => {
  const m = makeWanModel()
  await t.exception.all(
    m.run({ mode: 'txt2vid', prompt: 'hi', init_image: FAKE_PNG }),
    /txt2vid does not accept init_image/
  )
})

test('run | img2vid requires init_image', async (t) => {
  const m = makeWanModel()
  await t.exception.all(
    m.run({ mode: 'img2vid', prompt: 'hi' }),
    /img2vid requires init_image/
  )
})

// ─────────────────────────────────────────────────────────────────────
//  run(): control_frames (VACE)
// ─────────────────────────────────────────────────────────────────────

test('run | rejects non-array control_frames', async (t) => {
  const m = makeWanModel()
  await t.exception.all(
    m.run({ mode: 'txt2vid', prompt: 'hi', control_frames: FAKE_PNG }),
    /control_frames must be an Array of Uint8Array/
  )
})

test('run | rejects empty control_frames array', async (t) => {
  const m = makeWanModel()
  await t.exception.all(
    m.run({ mode: 'txt2vid', prompt: 'hi', control_frames: [] }),
    /control_frames must not be an empty array/
  )
})

test('run | rejects non-Uint8Array entry in control_frames (with index)', async (t) => {
  const m = makeWanModel()
  await t.exception.all(
    m.run({
      mode: 'txt2vid',
      prompt: 'hi',
      control_frames: [FAKE_PNG, 'not-buffer', FAKE_JPEG]
    }),
    /control_frames\[1\] must be a non-empty Uint8Array/
  )
})

test('run | rejects empty Uint8Array entry in control_frames', async (t) => {
  const m = makeWanModel()
  await t.exception.all(
    m.run({
      mode: 'txt2vid',
      prompt: 'hi',
      control_frames: [FAKE_PNG, new Uint8Array(0)]
    }),
    /control_frames\[1\] must be a non-empty Uint8Array/
  )
})

test('run | accepts control_frames with valid Uint8Array entries', async (t) => {
  const m = makeWanModel()
  await t.exception.all(
    m.run({
      mode: 'txt2vid',
      prompt: 'hi',
      control_frames: [FAKE_PNG, FAKE_JPEG, FAKE_PNG]
    }),
    /Addon not initialized/
  )
})

test('run | warns when vace_strength is set without control_frames', async (t) => {
  const { logger, events } = makeRecording()
  const m = makeWanModel({ logger })
  await t.exception.all(
    m.run({ mode: 'txt2vid', prompt: 'hi', vace_strength: 0.5 }),
    /Addon not initialized/
  )
  t.ok(
    events.warn.some((w) => /vace_strength was set but control_frames/.test(w)),
    'vace_strength-without-control_frames warning is emitted'
  )
})

test('run | does NOT warn when vace_strength is set and control_frames is present', async (t) => {
  const { logger, events } = makeRecording()
  const m = makeWanModel({ logger })
  await t.exception.all(
    m.run({
      mode: 'txt2vid',
      prompt: 'hi',
      vace_strength: 0.5,
      control_frames: [FAKE_PNG]
    }),
    /Addon not initialized/
  )
  t.absent(
    events.warn.some((w) => /vace_strength was set but control_frames/.test(w)),
    'no spurious warning when control_frames is present'
  )
})

// ─────────────────────────────────────────────────────────────────────
//  run(): Wan 2.2 high-noise warning
// ─────────────────────────────────────────────────────────────────────

test('run | warns when high_noise_* is set without files.highNoiseDiffusionModel', async (t) => {
  const { logger, events } = makeRecording()
  const m = makeWanModel({ logger })
  await t.exception.all(
    m.run({ mode: 'txt2vid', prompt: 'hi', high_noise_steps: 8 }),
    /Addon not initialized/
  )
  t.ok(
    events.warn.some((w) => /high_noise_steps.*Wan 2\.2-only/.test(w)),
    'warning lists the offending high_noise field'
  )
})

test('run | warns when moe_boundary is set without highNoiseDiffusionModel', async (t) => {
  const { logger, events } = makeRecording()
  const m = makeWanModel({ logger })
  await t.exception.all(
    m.run({ mode: 'txt2vid', prompt: 'hi', moe_boundary: 0.5 }),
    /Addon not initialized/
  )
  t.ok(
    events.warn.some((w) => /moe_boundary.*Wan 2\.2-only/.test(w)),
    'moe_boundary triggers the Wan 2.2 warning when no high-noise expert is set'
  )
})

test('run | does NOT warn about Wan 2.2 fields when highNoiseDiffusionModel is set', async (t) => {
  const { logger, events } = makeRecording()
  const m = new VideoStableDiffusion({
    files: {
      model: FAKE_MODEL,
      highNoiseDiffusionModel: FAKE_HIGH_NOISE,
      t5Xxl: FAKE_T5XXL,
      vae: FAKE_VAE
    },
    config: { threads: 1 },
    logger
  })
  await t.exception.all(
    m.run({
      mode: 'txt2vid',
      prompt: 'hi',
      high_noise_steps: 8,
      moe_boundary: 0.5
    }),
    /Addon not initialized/
  )
  t.absent(
    events.warn.some((w) => /Wan 2\.2-only/.test(w)),
    'no false warning when high-noise expert is configured'
  )
})

test('run | combines multiple high_noise_* params into a single warning', async (t) => {
  const { logger, events } = makeRecording()
  const m = makeWanModel({ logger })
  await t.exception.all(
    m.run({
      mode: 'txt2vid',
      prompt: 'hi',
      high_noise_steps: 8,
      high_noise_cfg_scale: 6.0,
      moe_boundary: 0.5
    }),
    /Addon not initialized/
  )
  const wanWarnings = events.warn.filter((w) => /Wan 2\.2-only/.test(w))
  t.is(wanWarnings.length, 1, 'one consolidated warning for all high_noise_* params')
  t.ok(/high_noise_steps/.test(wanWarnings[0]), 'warning mentions high_noise_steps')
  t.ok(/high_noise_cfg_scale/.test(wanWarnings[0]), 'warning mentions high_noise_cfg_scale')
  t.ok(/moe_boundary/.test(wanWarnings[0]), 'warning mentions moe_boundary')
})

// ─────────────────────────────────────────────────────────────────────
//  run(): LoRA is not yet supported on the video path
// ─────────────────────────────────────────────────────────────────────
//
// The native `SD_VID_GEN_HANDLERS` map has no "lora" entry and
// `SdModel::processVideo` never touches `sd_vid_gen_params_t::loras`,
// so we reject `params.lora` at the JS boundary to avoid silently
// dropping the adapter. When LoRA-on-video is wired through native,
// drop these tests and re-add the absolute-path validation tests.

test('run | rejects params.lora (not supported on video path yet)', async (t) => {
  const m = makeWanModel()
  // The same loud TypeError fires regardless of input shape -- whether
  // the value would have passed the old "non-empty absolute string"
  // check or not. Cover all four old shapes so a future re-introduction
  // of the validation can't bring back a silent-drop regression.
  for (const lora of ['', 42, 'lora.safetensors', '/tmp/lora.safetensors']) {
    await t.exception.all(
      m.run({ mode: 'txt2vid', prompt: 'hi', lora }),
      /params\.lora is not supported for video generation yet/
    )
  }
})

// ─────────────────────────────────────────────────────────────────────
//  Lifecycle: getState + cancel + unload (no native, no addon)
// ─────────────────────────────────────────────────────────────────────

test('lifecycle | getState() returns { configLoaded: false } before load', async (t) => {
  const m = makeWanModel()
  t.alike(m.getState(), { configLoaded: false }, 'initial state is unconfigured')
})

test('lifecycle | cancel() before load is a no-op', async (t) => {
  const m = makeWanModel()
  await t.execution(m.cancel(), 'cancel resolves cleanly when no addon is attached')
})

test('lifecycle | unload() before load is a no-op', async (t) => {
  const m = makeWanModel()
  await t.execution(m.unload(), 'unload resolves cleanly when no addon is attached')
  t.is(m.getState().configLoaded, false, 'state stays unconfigured after no-op unload')
})

test('lifecycle | run() before load() throws "Addon not initialized"', async (t) => {
  const m = makeWanModel()
  await t.exception.all(
    m.run({ mode: 'txt2vid', prompt: 'hi' }),
    /Addon not initialized\. Call load\(\) first\./
  )
})
