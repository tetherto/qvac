'use strict'

const os = require('bare-os')
const path = require('bare-path')
const process = require('bare-process')
const { GGMLBert } = require('../../index.js')
const { safeTest } = require('./utils')

// A multimodal embedding model (EmbeddingGemma 2) and its projection model.
// Neither is in models.manifest.json yet, so the tests read their paths from
// EMBED_MULTIMODAL_MODEL and EMBED_MULTIMODAL_MMPROJ and skip without them.
const MODEL = process.env.EMBED_MULTIMODAL_MODEL
const MMPROJ = process.env.EMBED_MULTIMODAL_MMPROJ
const skip = !MODEL || !MMPROJ

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

async function withModel(t, device, fn) {
  const model = new GGMLBert({
    files: { model: [path.resolve(MODEL)], projectionModel: path.resolve(MMPROJ) },
    config: device === 'gpu' ? { device: 'gpu', gpu_layers: '99' } : { device: 'cpu' },
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
  safeTest(`[${device}] image input yields one normalized 768-d embedding`, { skip }, async (t) => {
    await withModel(t, device, async (model) => {
      const vectors = await embed(model, ['title: none | text: ', { media: RED }])
      t.is(vectors.length, 1)
      t.is(vectors[0].length, 768)
      t.ok(Math.abs(norm(vectors[0]) - 1) < 1e-3, `unit norm: ${norm(vectors[0])}`)
    })
  })

  safeTest(`[${device}] an image is closer to the text describing it`, { skip }, async (t) => {
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

  safeTest(`[${device}] audio input yields a deterministic embedding`, { skip }, async (t) => {
    await withModel(t, device, async (model) => {
      const tone = sineWav()
      const first = await embed(model, [{ media: tone }])
      const second = await embed(model, [{ media: tone }])
      t.is(first[0].length, 768)
      t.ok(cosine(first[0], second[0]) > 0.9999, 'same audio, same embedding')
    })
  })

  safeTest(
    `[${device}] text and image in one input differ from either alone`,
    { skip },
    async (t) => {
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
    }
  )

  safeTest(`[${device}] text inputs match the text-only path`, { skip }, async (t) => {
    await withModel(t, device, async (model) => {
      // One string goes through the text path; the same string next to a
      // media input goes through the multimodal path.
      const [viaText] = await embed(model, QUERY + 'hello world')
      const vectors = await embed(model, { inputs: [QUERY + 'hello world', [{ media: RED }]] })
      t.ok(cosine(viaText, vectors[0]) > 0.999, `cosine ${cosine(viaText, vectors[0]).toFixed(6)}`)
    })
  })
}

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
    await t.exception.all(model.run([{ media: RED }]), /media input needs files\.projectionModel/)
  }
)

safeTest('files.projectionModel must be an absolute path', {}, (t) => {
  t.exception.all(
    () => new GGMLBert({ files: { model: ['/m.gguf'], projectionModel: 'relative/mmproj.gguf' } }),
    /files\.projectionModel must be an absolute path/
  )
})
