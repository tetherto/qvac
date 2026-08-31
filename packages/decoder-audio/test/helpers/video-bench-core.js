'use strict'

// Core logic for the temporary video decode benchmark (QVAC-23856 research).
// Downloads real phone-camera sample clips over HTTPS and measures bare-ffmpeg
// software decode + VLM-style frame sampling (2 fps, scale to 448px RGB24).
// Kept separate from the brittle test so it can also run standalone on desktop.

const fs = require('bare-fs')
const path = require('bare-path')
const os = require('bare-os')
const https = require('bare-https')
const ffmpeg = require('bare-ffmpeg')

// Byte-verified samples (2026-08-31). Small on purpose: ~88 MB total.
const CLIPS = [
  {
    name: 'iphone13pro_dv84_1080p30.mov',
    url: 'https://img.photographyblog.com/reviews/apple_iphone_13_pro/sample_images/FullHD30p.mov',
    bytes: 20466446,
    kind: 'HEVC Main10 DolbyVision 8.4 / HLG (real iPhone 13 Pro)'
  },
  {
    name: 'xperia5iii_hevc10_hlg_1080p.mp4',
    url: 'https://img.photographyblog.com/reviews/sony_xperia_5_iii/sample_images/FullHD_HDR.mp4',
    bytes: 38874051,
    kind: 'HEVC Main10 HLG (real Xperia 5 III)'
  },
  {
    name: 'pixel5_h264_1080p30.mp4',
    url: 'https://img.photographyblog.com/reviews/google_pixel_5/sample_images/pixel_5_video_1080_30fps.mp4',
    bytes: 28822562,
    kind: 'H.264 High 1080p (real Pixel 5)'
  },
  {
    name: 'bear_rotate_90.mp4',
    url: 'https://raw.githubusercontent.com/chromium/chromium/main/media/test/data/bear_rotate_90.mp4',
    bytes: 63080,
    kind: 'H.264 + 90-degree display matrix (portrait rotation)'
  }
]

const SAMPLE_FPS = 2
const MAX_SAMPLES = 32
const TARGET_WIDTH = 448

function downloadOnce (url, opts = {}) {
  const { timeoutMs = 240000, maxRedirects = 5, _redirectCount = 0 } = opts
  return new Promise((resolve, reject) => {
    let settled = false
    const fail = (err) => {
      if (settled) return
      settled = true
      reject(err)
    }
    const timer = setTimeout(() => {
      fail(new Error(`download timeout after ${timeoutMs}ms`))
      try {
        req.destroy()
      } catch (_) {}
    }, timeoutMs)
    const req = https.request(url, (res) => {
      if ([301, 302, 307, 308].includes(res.statusCode)) {
        clearTimeout(timer)
        if (_redirectCount >= maxRedirects) return fail(new Error('too many redirects'))
        const next = new URL(res.headers.location, url).href
        settled = true
        downloadOnce(next, { ...opts, _redirectCount: _redirectCount + 1 }).then(resolve, reject)
        return
      }
      if (res.statusCode !== 200) {
        clearTimeout(timer)
        return fail(new Error(`HTTP ${res.statusCode}`))
      }
      const chunks = []
      res.on('data', (c) => chunks.push(c))
      res.on('end', () => {
        clearTimeout(timer)
        if (settled) return
        settled = true
        resolve(Buffer.concat(chunks))
      })
      res.on('error', fail)
    })
    req.on('error', (err) => {
      clearTimeout(timer)
      fail(err)
    })
    req.end()
  })
}

async function downloadClip (clip, retries = 3) {
  let lastErr = null
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const t0 = Date.now()
      const buf = await downloadOnce(clip.url)
      if (buf.length !== clip.bytes) {
        throw new Error(`size mismatch: got ${buf.length}, expected ${clip.bytes}`)
      }
      return { buf, downloadMs: Date.now() - t0 }
    } catch (err) {
      lastErr = err
      console.log(`[VBENCH-DL] ${clip.name} attempt ${attempt}/${retries} failed: ${err.message}`)
      await new Promise((resolve) => setTimeout(resolve, 2000 * attempt))
    }
  }
  throw lastErr
}

// AVColorTransferCharacteristic: 16 = PQ (HDR10), 18 = HLG
function hdrKind (trc) {
  if (trc === 16) return 'HDR10/PQ'
  if (trc === 18) return 'HLG'
  return 'SDR'
}

function benchBuffer (name, bytes, opts = {}) {
  const { skipFrame = '' } = opts
  const r = { file: name, ok: false, sizeMB: +(bytes.length / 1048576).toFixed(1) }
  let fmt = null
  let dec = null
  let scaler = null
  let packet = null
  let frame = null
  let outFrame = null
  try {
    const tOpen0 = Date.now()
    fmt = new ffmpeg.InputFormatContext(new ffmpeg.IOContext(bytes))
    const stream = fmt.getBestStream(ffmpeg.constants.mediaTypes.VIDEO)
    if (!stream) throw new Error('no video stream')
    const par = stream.codecParameters
    r.codecId = par.id
    r.profile = par.profile
    r.width = par.width
    r.height = par.height
    r.trc = par.colorTRC
    r.hdr = hdrKind(par.colorTRC)
    const tb = stream.timeBase
    const dUs = fmt.duration
    r.durationS =
      dUs > 0
        ? +(dUs / 1e6).toFixed(1)
        : +((stream.duration * tb.numerator) / tb.denominator).toFixed(1)
    try {
      r.sideData = stream.sideData.map((s) => s.name || String(s.type))
    } catch (e) {
      r.sideData = []
    }
    r.openMs = Date.now() - tOpen0
    if (skipFrame) r.skip = skipFrame

    dec = stream.decoder()
    const opts2 = { threads: 'auto' }
    if (skipFrame) opts2.skip_frame = skipFrame
    dec.open(ffmpeg.Dictionary.from(opts2))
    packet = new ffmpeg.Packet()
    frame = new ffmpeg.Frame()

    let decoded = 0
    let sampled = 0
    let nextSampleSec = 0
    let firstPts = null
    let is10bit = false
    let scaleMsTotal = 0
    const tDec0 = Date.now()

    while (fmt.readFrame(packet)) {
      if (packet.streamIndex !== stream.index) {
        packet.unref()
        continue
      }
      dec.sendPacket(packet)
      packet.unref()
      while (dec.receiveFrame(frame)) {
        decoded++
        if (firstPts === null) firstPts = frame.pts
        const sec = ((frame.pts - firstPts) * tb.numerator) / tb.denominator
        if (sampled < MAX_SAMPLES && sec + 1e-6 >= nextSampleSec) {
          nextSampleSec += 1 / SAMPLE_FPS
          if (!scaler) {
            r.pixFmtId = frame.format
            is10bit = frame.format !== ffmpeg.constants.pixelFormats.YUV420P && frame.format !== 12
            const outH = Math.round(((frame.height / frame.width) * TARGET_WIDTH) / 2) * 2
            scaler = new ffmpeg.Scaler(
              frame.format,
              frame.width,
              frame.height,
              'RGB24',
              TARGET_WIDTH,
              outH
            )
            outFrame = new ffmpeg.Frame()
            outFrame.width = TARGET_WIDTH
            outFrame.height = outH
            outFrame.format = ffmpeg.constants.pixelFormats.RGB24
            outFrame.alloc()
          }
          const tS0 = Date.now()
          scaler.scale(frame, outFrame)
          scaleMsTotal += Date.now() - tS0
          sampled++
        }
      }
    }
    const decMs = Date.now() - tDec0
    r.is10bit = is10bit
    r.framesDecoded = decoded
    r.framesSampled = sampled
    r.decodeMs = decMs
    r.decodeFps = decoded > 0 ? +(decoded / (decMs / 1000)).toFixed(1) : 0
    r.scaleMsAvg = sampled ? +(scaleMsTotal / sampled).toFixed(1) : 0
    r.realtimeX = r.durationS > 0 ? +((r.durationS * 1000) / decMs).toFixed(1) : 0
    r.ok = decoded > 0
    if (!r.ok) r.error = 'zero frames decoded'
  } catch (err) {
    r.error = String((err && err.message) || err)
  } finally {
    for (const h of [frame, packet, outFrame]) {
      try {
        if (h) h.destroy()
      } catch (_) {}
    }
    try {
      if (scaler) scaler.destroy()
    } catch (_) {}
    try {
      if (dec) dec.destroy()
    } catch (_) {}
    try {
      if (fmt) fmt.destroy()
    } catch (_) {}
  }
  console.log('[VBENCH] ' + JSON.stringify(r))
  return r
}

function platformLabel () {
  return `${os.platform()}-${os.arch()}`
}

module.exports = { CLIPS, downloadClip, benchBuffer, platformLabel, tmpDir: () => os.tmpdir(), fs, path }
