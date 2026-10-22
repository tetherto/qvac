'use strict'

const os = require('bare-os')
const path = require('bare-path')
const process = require('bare-process')
const { GGMLBert } = require('../../index.js')
const { ensureModel, safeTest } = require('./utils')

// A multimodal embedding model (EmbeddingGemma 2) and its projection model,
// from models.manifest.json (downloaded on desktop, pre-staged on mobile).
// EMBED_MULTIMODAL_MODEL and EMBED_MULTIMODAL_MMPROJ point at local copies
// instead.
const MODEL_NAME = 'embeddinggemma-2-Q8_0.gguf'
const MMPROJ_NAME = 'mmproj-embeddinggemma-2-Q8_0.gguf'
let multimodalFiles = null
function modelFiles() {
  multimodalFiles ??= (async () => {
    const { EMBED_MULTIMODAL_MODEL: model, EMBED_MULTIMODAL_MMPROJ: mmproj } = process.env
    if (model && mmproj) {
      return { model: path.resolve(model), projectionModel: path.resolve(mmproj) }
    }
    const [modelName, modelDir] = await ensureModel({ modelName: MODEL_NAME })
    const [mmprojName, mmprojDir] = await ensureModel({ modelName: MMPROJ_NAME })
    return {
      model: path.join(modelDir, modelName),
      projectionModel: path.join(mmprojDir, mmprojName)
    }
  })()
  return multimodalFiles
}

const platform = os.platform()
const arch = os.arch()
const isDarwinX64 = platform === 'darwin' && arch === 'x64'
const isLinuxArm64 = platform === 'linux' && arch === 'arm64'
// As the other embed tests: these runners load on the CPU.
const DEVICES = isDarwinX64 || isLinuxArm64 ? ['cpu'] : ['cpu', 'gpu']

// A 32x32 24-bit BMP of one color (stb_image decodes BMP).
function solidBmp([r, g, b], size = 32) {
  const rowBytes = size * 3
  const pixelBytes = rowBytes * size
  const buf = new Uint8Array(54 + pixelBytes)
  const view = new DataView(buf.buffer)
  buf.set([0x42, 0x4d]) // "BM"
  view.setUint32(2, buf.length, true)
  view.setUint32(10, 54, true) // pixel data offset
  view.setUint32(14, 40, true) // BITMAPINFOHEADER
  view.setInt32(18, size, true)
  view.setInt32(22, size, true)
  view.setUint16(26, 1, true) // planes
  view.setUint16(28, 24, true) // bits per pixel
  view.setUint32(34, pixelBytes, true)
  for (let i = 54; i < buf.length; i += 3) {
    buf[i] = b
    buf[i + 1] = g
    buf[i + 2] = r
  }
  return buf
}

// One second of a 16 kHz mono 16-bit PCM WAV sine tone (miniaudio decodes WAV).
function sineWav(frequency = 440, seconds = 1, sampleRate = 16000) {
  const n = sampleRate * seconds
  const buf = new Uint8Array(44 + n * 2)
  const view = new DataView(buf.buffer)
  buf.set([0x52, 0x49, 0x46, 0x46], 0) // "RIFF"
  view.setUint32(4, buf.length - 8, true)
  buf.set([0x57, 0x41, 0x56, 0x45, 0x66, 0x6d, 0x74, 0x20], 8) // "WAVEfmt "
  view.setUint32(16, 16, true)
  view.setUint16(20, 1, true) // PCM
  view.setUint16(22, 1, true) // mono
  view.setUint32(24, sampleRate, true)
  view.setUint32(28, sampleRate * 2, true)
  view.setUint16(32, 2, true)
  view.setUint16(34, 16, true)
  buf.set([0x64, 0x61, 0x74, 0x61], 36) // "data"
  view.setUint32(40, n * 2, true)
  for (let i = 0; i < n; i++) {
    view.setInt16(
      44 + i * 2,
      Math.round(0.5 * 32767 * Math.sin((2 * Math.PI * frequency * i) / sampleRate)),
      true
    )
  }
  return buf
}

function cosine(a, b) {
  let dot = 0
  let na = 0
  let nb = 0
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i]
    na += a[i] * a[i]
    nb += b[i] * b[i]
  }
  return dot / Math.sqrt(na * nb)
}

function norm(v) {
  return Math.sqrt(v.reduce((sum, x) => sum + x * x, 0))
}

// The same pixels as solidBmp, as a binary PPM (P6).
function solidPpm([r, g, b], size = 32) {
  const header = Uint8Array.from(`P6\n${size} ${size}\n255\n`, (c) => c.charCodeAt(0))
  const buf = new Uint8Array(header.length + size * size * 3)
  buf.set(header)
  for (let i = header.length; i < buf.length; i += 3) buf.set([r, g, b], i)
  return buf
}

// The same pixels as solidBmp, as an uncompressed 24-bit TGA.
function solidTga([r, g, b], size = 32) {
  const buf = new Uint8Array(18 + size * size * 3)
  const view = new DataView(buf.buffer)
  buf[2] = 2 // uncompressed true-color
  view.setUint16(12, size, true)
  view.setUint16(14, size, true)
  buf[16] = 24
  buf[17] = 0x20 // top-left origin
  for (let i = 18; i < buf.length; i += 3) buf.set([b, g, r], i)
  return buf
}

// The tone of sineWav as 32-bit float PCM.
function sineWavF32(frequency = 440, seconds = 1, sampleRate = 16000) {
  const n = sampleRate * seconds
  const buf = new Uint8Array(44 + n * 4)
  const view = new DataView(buf.buffer)
  buf.set([0x52, 0x49, 0x46, 0x46], 0) // "RIFF"
  view.setUint32(4, buf.length - 8, true)
  buf.set([0x57, 0x41, 0x56, 0x45, 0x66, 0x6d, 0x74, 0x20], 8) // "WAVEfmt "
  view.setUint32(16, 16, true)
  view.setUint16(20, 3, true) // IEEE float
  view.setUint16(22, 1, true) // mono
  view.setUint32(24, sampleRate, true)
  view.setUint32(28, sampleRate * 4, true)
  view.setUint16(32, 4, true)
  view.setUint16(34, 32, true)
  buf.set([0x64, 0x61, 0x74, 0x61], 36) // "data"
  view.setUint32(40, n * 4, true)
  for (let i = 0; i < n; i++) {
    // Rounded as sineWav rounds, so both carry the same samples.
    const s16 = Math.round(0.5 * 32767 * Math.sin((2 * Math.PI * frequency * i) / sampleRate))
    view.setFloat32(44 + i * 4, s16 / 32768, true)
  }
  return buf
}

// As createEmbeddingsTestInstance loads: flash attention off on Android, and
// OpenCL's kernel cache next to the model.
function deviceConfig(device, modelPath) {
  const config = device === 'gpu' ? { device: 'gpu', gpu_layers: '99' } : { device: 'cpu' }
  if (platform === 'android') config.flash_attn = 'off'
  config.openclCacheDir = path.dirname(modelPath)
  return config
}

async function withModel(t, device, fn, extraConfig = {}) {
  const files = await modelFiles()
  const model = new GGMLBert({
    files: { model: [files.model], projectionModel: files.projectionModel },
    config: { ...deviceConfig(device, files.model), ...extraConfig },
    opts: { stats: true }
  })
  try {
    await model.load()
    return await fn(model)
  } finally {
    await model.unload().catch((err) => t.comment(`unload failed: ${err.message}`))
  }
}

async function embed(model, input) {
  const response = await model.run(input)
  const [vectors] = await response.await()
  return vectors
}

const RED = solidBmp([255, 0, 0])
const BLUE = solidBmp([0, 0, 255])
const QUERY = 'task: search result | query: '

for (const device of DEVICES) {
  safeTest(`[${device}] image input yields one normalized 768-d embedding`, {}, async (t) => {
    await withModel(t, device, async (model) => {
      const vectors = await embed(model, { inputs: [['title: none | text: ', { media: RED }]] })
      t.is(vectors.length, 1)
      t.is(vectors[0].length, 768)
      t.ok(Math.abs(norm(vectors[0]) - 1) < 1e-3, `unit norm: ${norm(vectors[0])}`)
    })
  })

  safeTest(`[${device}] an image is closer to the text describing it`, {}, async (t) => {
    await withModel(t, device, async (model) => {
      const vectors = await embed(model, {
        inputs: [
          ['title: none | text: ', { media: RED }],
          ['title: none | text: ', { media: BLUE }],
          QUERY + 'a plain red square',
          QUERY + 'a plain blue square'
        ]
      })
      t.is(vectors.length, 4)
      const [red, blue, redText, blueText] = vectors
      t.ok(
        cosine(red, redText) > cosine(red, blueText),
        `red image: red ${cosine(red, redText).toFixed(4)} > blue ${cosine(red, blueText).toFixed(4)}`
      )
      t.ok(
        cosine(blue, blueText) > cosine(blue, redText),
        `blue image: blue ${cosine(blue, blueText).toFixed(4)} > red ${cosine(blue, redText).toFixed(4)}`
      )
    })
  })

  safeTest(`[${device}] audio input yields a deterministic embedding`, {}, async (t) => {
    await withModel(t, device, async (model) => {
      const tone = sineWav()
      const first = await embed(model, { inputs: [[{ media: tone }]] })
      const second = await embed(model, { inputs: [[{ media: tone }]] })
      t.is(first[0].length, 768)
      t.ok(cosine(first[0], second[0]) > 0.9999, 'same audio, same embedding')
    })
  })

  safeTest(`[${device}] text and image in one input differ from either alone`, {}, async (t) => {
    await withModel(t, device, async (model) => {
      const vectors = await embed(model, {
        inputs: [
          [QUERY + 'red ', { media: RED }],
          QUERY + 'red ',
          ['title: none | text: ', { media: RED }]
        ]
      })
      const [mixed, textOnly, imageOnly] = vectors
      t.ok(cosine(mixed, textOnly) < 0.9999, 'mixed differs from its text')
      t.ok(cosine(mixed, imageOnly) < 0.9999, 'mixed differs from its image')
    })
  })

  safeTest(`[${device}] text inputs match the text-only path`, {}, async (t) => {
    await withModel(t, device, async (model) => {
      // One string goes through the text path; the same string next to a
      // media input goes through the multimodal path.
      const [viaText] = await embed(model, QUERY + 'hello world')
      const vectors = await embed(model, { inputs: [QUERY + 'hello world', [{ media: RED }]] })
      t.ok(cosine(viaText, vectors[0]) > 0.999, `cosine ${cosine(viaText, vectors[0]).toFixed(6)}`)
    })
  })

  safeTest(`[${device}] the same media in other formats embeds the same`, {}, async (t) => {
    await withModel(t, device, async (model) => {
      const prefix = 'title: none | text: '
      const [bmp, ppm, tga, s16, f32] = await embed(model, {
        inputs: [
          [prefix, { media: RED }],
          [prefix, { media: solidPpm([255, 0, 0]) }],
          [prefix, { media: solidTga([255, 0, 0]) }],
          [prefix, { media: sineWav() }],
          [prefix, { media: sineWavF32() }]
        ]
      })
      t.ok(cosine(bmp, ppm) > 0.9999, `ppm vs bmp ${cosine(bmp, ppm).toFixed(6)}`)
      t.ok(cosine(bmp, tga) > 0.9999, `tga vs bmp ${cosine(bmp, tga).toFixed(6)}`)
      t.ok(cosine(s16, f32) > 0.9999, `f32 vs s16 wav ${cosine(s16, f32).toFixed(6)}`)
    })
  })
}

// The projector options. Each loads its own instance, on the GPU where the
// runner has one.
const OPTIONS_DEVICE = DEVICES[DEVICES.length - 1]
const BIG = solidBmp([0, 128, 255], 1024) // 1024 x 1024, about 1.05 MP

async function imageTokens(model, image) {
  const response = await model.run({ inputs: [[{ media: image }]] })
  await response.await()
  return response.stats.total_tokens
}

safeTest('image-max-tokens bounds the tokens of a large image', {}, async (t) => {
  const byDefault = await withModel(t, OPTIONS_DEVICE, (model) => imageTokens(model, BIG))
  const capped = await withModel(t, OPTIONS_DEVICE, (model) => imageTokens(model, BIG), {
    'image-max-tokens': '280'
  })
  t.comment(`tokens: default ${byDefault}, image-max-tokens 280 -> ${capped}`)
  // BOS and EOS around the image tokens.
  t.ok(capped <= 282, `capped image uses at most 280 tokens (${capped})`)
  t.ok(capped < byDefault, 'the cap lowers the default budget')
})

safeTest('mmproj-no-audio rejects audio and keeps images', {}, async (t) => {
  await withModel(
    t,
    OPTIONS_DEVICE,
    async (model) => {
      const [image] = await embed(model, { inputs: [[{ media: RED }]] })
      t.is(image.length, 768, 'images still embed')
      await t.exception.all(
        embed(model, { inputs: [[{ media: sineWav() }]] }),
        /no audio encoder loaded/
      )
    },
    { 'mmproj-no-audio': 'true' }
  )
})

safeTest('image-max-megapixels rejects a larger image before decoding', {}, async (t) => {
  await withModel(
    t,
    OPTIONS_DEVICE,
    async (model) => {
      await t.exception.all(embed(model, { inputs: [[{ media: BIG }]] }), /exceeds the 1 MP limit/)
      const [small] = await embed(model, { inputs: [[{ media: RED }]] })
      t.is(small.length, 768, 'a smaller image still embeds')
    },
    { 'image-max-megapixels': '1' }
  )
})

safeTest('audio-max-seconds rejects longer audio before decoding', {}, async (t) => {
  await withModel(
    t,
    OPTIONS_DEVICE,
    async (model) => {
      await t.exception.all(
        embed(model, { inputs: [[{ media: sineWav(440, 2) }]] }),
        /exceeds the 1 s limit/
      )
      const [short] = await embed(model, { inputs: [[{ media: sineWav(440, 1) }]] })
      t.is(short.length, 768, 'audio within the limit still embeds')
    },
    { 'audio-max-seconds': '1' }
  )
})

safeTest('a WAV that decodes past the limit is rejected before decoding', {}, async (t) => {
  await withModel(t, OPTIONS_DEVICE, async (model) => {
    // 700 samples at 1 Hz: 1.4 kB that decode to 700 s, resampled to the
    // model's rate (about 11 million samples).
    const wav = sineWav(440, 700, 1)
    await t.exception.all(embed(model, { inputs: [[{ media: wav }]] }), /exceeds the 600 s limit/)
  })
})

safeTest('cancel stops a running multimodal request', { timeout: 600_000 }, async (t) => {
  await withModel(t, 'cpu', async (model) => {
    // Several long clips, so the cancel lands while the job runs.
    const clip = sineWav(440, 60)
    const response = await model.run({ inputs: Array.from({ length: 6 }, () => [{ media: clip }]) })
    await new Promise((resolve) => setTimeout(resolve, 200))
    await model.cancel()
    await t.exception(response.await(), /Job cancelled/)

    // The cancel does not fail the next job.
    const [after] = await embed(model, { inputs: [[{ media: RED }]] })
    t.is(after.length, 768)
  })
})

safeTest('media whose format cannot be decoded is rejected', {}, async (t) => {
  await withModel(t, OPTIONS_DEVICE, async (model) => {
    // A WebP header (decoded only through ffmpeg) and bytes of no format.
    const webp = new Uint8Array([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50])
    await t.exception.all(
      embed(model, { inputs: [[{ media: webp }]] }),
      /Unsupported or corrupt image/
    )
    await t.exception.all(
      embed(model, { inputs: [[{ media: new Uint8Array(64).fill(7) }]] }),
      /Unsupported or corrupt image/
    )
  })
})

safeTest(
  'mmproj-use-gpu off runs the projector on the CPU',
  { skip: OPTIONS_DEVICE !== 'gpu' },
  async (t) => {
    const input = { inputs: [['title: none | text: ', { media: RED }]] }
    const [onGpu] = await withModel(t, 'gpu', (model) => embed(model, input))
    const [onCpu] = await withModel(t, 'gpu', (model) => embed(model, input), {
      'mmproj-use-gpu': 'false'
    })
    t.ok(cosine(onGpu, onCpu) > 0.999, `same embedding: ${cosine(onGpu, onCpu).toFixed(6)}`)
  }
)

safeTest('projector options without files.projectionModel fail the load', {}, async (t) => {
  // They would do nothing without a projection model. Options are checked before
  // the model file is read, so no model is needed.
  const model = new GGMLBert({
    files: { model: ['/nonexistent/model.gguf'] },
    config: { device: 'cpu', 'image-max-tokens': '280' }
  })
  await t.exception.all(model.load(), /projector options .* need files\.projectionModel/)
})

safeTest('an invalid projector option fails the load', {}, async (t) => {
  // Options are checked before the model file is read, so no model is needed.
  const model = new GGMLBert({
    files: { model: ['/nonexistent/model.gguf'], projectionModel: '/nonexistent/mmproj.gguf' },
    config: { device: 'cpu', 'image-max-tokens': 'many' }
  })
  await t.exception.all(model.load(), /image-max-tokens must be a positive integer/)
})

safeTest(
  'media without files.projectionModel is rejected before reaching the model',
  {},
  async (t) => {
    const model = new GGMLBert({
      files: { model: ['/nonexistent/model.gguf'] },
      config: { device: 'cpu' }
    })
    // run() checks the input before it needs a loaded addon, so fake one.
    model.addon = {}
    await t.exception.all(
      model.run({ inputs: [[{ media: RED }]] }),
      /media input needs files\.projectionModel/
    )
  }
)

safeTest('files.projectionModel must be an absolute path', {}, (t) => {
  t.exception.all(
    () => new GGMLBert({ files: { model: ['/m.gguf'], projectionModel: 'relative/mmproj.gguf' } }),
    /files\.projectionModel must be an absolute path/
  )
})
