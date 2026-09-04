'use strict'

// Unit coverage for the ABot-World numerical guards.
//
// The guards themselves are what stand between a silent conditioning
// regression and a red CI run, so they are exercised here on synthetic inputs:
// no models, no GPU, no native prebuild, milliseconds. If a refactor breaks a
// guard's arithmetic, this lane fails instead of the guard quietly passing
// everything in the expensive model lane.

const test = require('brittle')
const zlib = require('bare-zlib')
const { pngLuminanceStddev, readScenePackPromptRows } = require('../integration/abot-guards.js')

function crc32(buf) {
  let c = ~0
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i]
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1))
  }
  return ~c >>> 0
}

function chunk(type, data) {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length)
  const body = Buffer.concat([Buffer.from(type, 'latin1'), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(body))
  return Buffer.concat([len, body, crc])
}

// Minimal 8-bit truecolour PNG, filter 0, from a (x, y) -> [r, g, b] function.
function makePng(width, height, pixel) {
  const stride = width * 3
  const raw = Buffer.alloc((stride + 1) * height)
  let p = 0
  for (let y = 0; y < height; y++) {
    raw[p++] = 0
    for (let x = 0; x < width; x++) {
      const [r, g, b] = pixel(x, y)
      raw[p++] = r
      raw[p++] = g
      raw[p++] = b
    }
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 2 // colour type: truecolour
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0))
  ])
}

// Same image as makePng, but each row is encoded with the PNG filter type
// rowFilter(y) returns (0=None, 1=Sub, 2=Up, 3=Average, 4=Paeth), applying the
// forward filter so the guard's per-row reconstruction has to invert it. This
// exercises the Sub/Up/Average/Paeth paths, not just None (bpp = 3).
function makePngFiltered(width, height, pixel, rowFilter) {
  const stride = width * 3
  const raw = Buffer.alloc((stride + 1) * height)
  let prev = Buffer.alloc(stride)
  let p = 0
  for (let y = 0; y < height; y++) {
    const line = Buffer.alloc(stride)
    for (let x = 0; x < width; x++) {
      const [r, g, b] = pixel(x, y)
      line[x * 3] = r
      line[x * 3 + 1] = g
      line[x * 3 + 2] = b
    }
    const ft = rowFilter(y)
    raw[p++] = ft
    for (let i = 0; i < stride; i++) {
      const a = i >= 3 ? line[i - 3] : 0
      const b = prev[i]
      const c = i >= 3 ? prev[i - 3] : 0
      let pred = 0
      if (ft === 1) pred = a
      else if (ft === 2) pred = b
      else if (ft === 3) pred = (a + b) >> 1
      else if (ft === 4) {
        const pp = a + b - c
        const pa = Math.abs(pp - a)
        const pb = Math.abs(pp - b)
        const pc = Math.abs(pp - c)
        pred = pa <= pb && pa <= pc ? a : pb <= pc ? b : c
      }
      raw[p++] = (line[i] - pred) & 255
    }
    prev = line
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8
  ihdr[9] = 2
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0))
  ])
}

// safetensors scene pack carrying only prompt_embeds [1, rows, emb].
function makeScenePack(rows, emb, fillRow) {
  const data = Buffer.alloc(rows * emb * 4)
  for (let r = 0; r < rows; r++) {
    for (let i = 0; i < emb; i++) data.writeFloatLE(fillRow(r, i), (r * emb + i) * 4)
  }
  const header = Buffer.from(
    JSON.stringify({
      prompt_embeds: { dtype: 'F32', shape: [1, rows, emb], data_offsets: [0, data.length] }
    }),
    'utf8'
  )
  const len = Buffer.alloc(8)
  len.writeBigUInt64LE(BigInt(header.length))
  return Buffer.concat([len, header, data])
}

test('pngLuminanceStddev: separates collapsed frames from real ones', function (t) {
  // A conditioning collapse renders as near-uniform low-contrast mush. Real
  // walk frames carry structure. The lanes gate at 20.
  const flat = pngLuminanceStddev(makePng(64, 48, () => [110, 108, 112]))
  t.ok(flat < 5, `uniform frame measures flat (${flat.toFixed(1)} < 5)`)

  const structured = pngLuminanceStddev(
    makePng(64, 48, (x, y) => (((x >> 3) + (y >> 3)) % 2 ? [235, 230, 220] : [25, 30, 35]))
  )
  t.ok(structured > 20, `structured frame clears the gate (${structured.toFixed(1)} > 20)`)
  t.ok(structured > flat * 4, 'structured frame measures far above a uniform one')

  t.is(pngLuminanceStddev(Buffer.alloc(64)), -1, 'non-PNG input is reported, not thrown on')
})

test('pngLuminanceStddev: handles every PNG row filter', function (t) {
  // Encoders pick filters per row; the guard reverses all five. A wrong
  // reconstruction would fabricate contrast and mask a real collapse. Encode
  // the SAME image once as filter 0 and once with every row cycling through
  // filters 0-4, and require both to measure identically - which can only hold
  // if Sub/Up/Average/Paeth all reconstruct correctly.
  const pixel = (x, y) => [x * 8, y * 8, 128]
  const baseline = pngLuminanceStddev(makePng(32, 32, pixel))
  const allFilters = pngLuminanceStddev(makePngFiltered(32, 32, pixel, (y) => y % 5))
  t.ok(baseline > 20, `gradient reconstructs with real contrast (${baseline.toFixed(1)})`)
  t.ok(
    Math.abs(allFilters - baseline) < 1e-6,
    `all five row filters reconstruct to the same image ` +
      `(${allFilters.toFixed(3)} == ${baseline.toFixed(3)})`
  )
})

test('readScenePackPromptRows: counts live prompt rows', function (t) {
  // Reference behaviour: rows past the last token are zeroed, so `live` is the
  // token count.
  const healthy = makeScenePack(16, 4, (r, i) => (r < 5 ? 0.5 + i : 0))
  const census = readScenePackPromptRows(healthy)
  t.is(census.rows, 16, 'row count read from the header')
  t.is(census.emb, 4, 'embedding width read from the header')
  t.is(census.live, 5, 'live rows stop at the zero padding')
  t.is(census.prefix.length, 5 * 4 * 4, 'prefix covers exactly the live rows')
})

test('readScenePackPromptRows: flags a pack whose padding is not zeroed', function (t) {
  // The shape of the 2026-08-11 regression: every row carries an embedding,
  // so the walk is conditioned on pad tokens. The lane asserts live < rows.
  const regressed = makeScenePack(16, 4, (r, i) => 0.25 + i * 0.1)
  const census = readScenePackPromptRows(regressed)
  t.is(census.live, census.rows, 'all rows live - padding was never zeroed')
})

test('readScenePackPromptRows: prompt sensitivity is visible in the prefix', function (t) {
  const a = readScenePackPromptRows(makeScenePack(8, 4, (r, i) => (r < 3 ? 1 + i : 0)))
  const b = readScenePackPromptRows(makeScenePack(8, 4, (r, i) => (r < 3 ? 2 + i : 0)))
  t.ok(!a.prefix.equals(b.prefix), 'different embeddings produce different prefixes')
  const same = readScenePackPromptRows(makeScenePack(8, 4, (r, i) => (r < 3 ? 1 + i : 0)))
  t.ok(a.prefix.equals(same.prefix), 'identical embeddings compare equal')
})

test('readScenePackPromptRows: rejects a pack without prompt_embeds', function (t) {
  const header = Buffer.from(
    JSON.stringify({ other: { dtype: 'F32', shape: [1], data_offsets: [0, 4] } })
  )
  const len = Buffer.alloc(8)
  len.writeBigUInt64LE(BigInt(header.length))
  t.exception(
    () => readScenePackPromptRows(Buffer.concat([len, header, Buffer.alloc(4)])),
    /no prompt_embeds/,
    'a pack missing the prompt tensor is an error, not a silent pass'
  )
})
