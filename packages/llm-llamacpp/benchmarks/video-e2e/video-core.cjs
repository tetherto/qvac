'use strict'

const fs = require('bare-fs')
const path = require('bare-path')
const https = require('bare-https')
const crypto = require('bare-crypto')
const ffmpeg = require('bare-ffmpeg')
const { settings } = require('./video-config.cjs')

function hashFile(file) {
  const fd = fs.openSync(file, 'r')
  const hash = crypto.createHash('sha256')
  const buf = Buffer.alloc(1024 * 1024)
  try {
    let count
    let position = 0
    while ((count = fs.readSync(fd, buf, 0, buf.length, position)) > 0) {
      hash.update(buf.subarray(0, count))
      position += count
    }
    return hash.digest('hex')
  } finally {
    fs.closeSync(fd)
  }
}

async function download(clip, directory) {
  fs.mkdirSync(directory, { recursive: true })
  const file = path.join(directory, clip.file)
  const valid = () =>
    fs.existsSync(file) &&
    (!clip.bytes || fs.statSync(file).size === clip.bytes) &&
    (!clip.sha256 || hashFile(file) === clip.sha256)
  if (valid()) return { file, downloadMs: 0, cached: true }
  const partial = file + '.part'
  const start = Date.now()
  async function fetchFile(url, redirects = 0) {
    if (redirects > 5) throw new Error('too many redirects')
    await new Promise((resolve, reject) => {
      let fd = null
      let settled = false
      let received = 0
      const finish = (err) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        if (fd !== null) fs.closeSync(fd)
        if (err) reject(err)
        else resolve()
      }
      const req = https.get(url, (res) => {
        if ([301, 302, 303, 307, 308].includes(res.statusCode)) {
          res.resume()
          clearTimeout(timer)
          fetchFile(new URL(res.headers.location, url).href, redirects + 1).then(
            () => finish(),
            finish
          )
          return
        }
        if (res.statusCode !== 200) {
          res.resume()
          return finish(new Error('HTTP ' + res.statusCode))
        }
        fd = fs.openSync(partial, 'w')
        res.on('data', (chunk) => {
          if (settled) return
          try {
            received += chunk.length
            if (received > settings.maxDownloadBytes) {
              throw new Error('download byte limit exceeded')
            }
            fs.writeSync(fd, chunk)
          } catch (err) {
            finish(err)
            req.destroy()
          }
        })
        res.on('end', () => finish())
        res.on('error', finish)
      })
      const timer = setTimeout(() => {
        finish(new Error('download exceeded 240 seconds'))
        req.destroy()
      }, 240000)
      req.on('error', finish)
    })
  }
  try {
    await fetchFile(clip.url)
    if (clip.bytes && fs.statSync(partial).size !== clip.bytes) {
      throw new Error('download size mismatch')
    }
    if (clip.sha256 && hashFile(partial) !== clip.sha256) {
      throw new Error('download SHA256 mismatch')
    }
    fs.renameSync(partial, file)
    return { file, downloadMs: Date.now() - start, cached: false }
  } finally {
    if (fs.existsSync(partial)) fs.unlinkSync(partial)
  }
}

function extract(file, mode, options = {}) {
  if (!['full', 'key', 'all-short'].includes(mode)) throw new Error('invalid extraction mode')
  const totalStart = Date.now()
  const fd = fs.openSync(file, 'r')
  const size = fs.fstatSync(fd).size
  let offset = 0
  let fmt, dec, packet, frame, output, scaler
  const frames = []
  const record = { mode, bytes: size, ffmpegPackage: 'bare-ffmpeg@1.5.0' }
  try {
    const io = new ffmpeg.IOContext(65536, {
      onread: (buffer, wanted) => {
        const n = fs.readSync(fd, buffer, 0, Math.min(wanted, buffer.length), offset)
        offset += n
        return n
      },
      onseek: (position, whence) => {
        if (whence & 0x10000) return size
        const origin = whence & 0xffff
        const next = (origin === 0 ? 0 : origin === 1 ? offset : size) + position
        if (next < 0 || next > size) return -1
        offset = next
        return offset
      }
    })
    fmt = new ffmpeg.InputFormatContext(io)
    const stream = fmt.getBestStream(ffmpeg.constants.mediaTypes.VIDEO)
    if (!stream) throw new Error('no video stream')
    const par = stream.codecParameters
    const tb = stream.timeBase.numerator / stream.timeBase.denominator
    const duration = fmt.duration > 0 ? fmt.duration / 1e6 : stream.duration * tb
    const limit = Math.min(duration, options.limitSeconds || settings.maxVideoSeconds)
    const cap = options.maxFrames || settings.maxFrames
    const interval = mode === 'all-short' ? 0 : Math.max(1 / settings.fps, limit / cap)
    Object.assign(record, {
      width: par.width,
      height: par.height,
      codecId: par.id,
      profile: par.profile,
      colorTRC: par.colorTRC,
      sourceDurationS: duration,
      testedDurationS: limit,
      sampleIntervalS: interval,
      probeMs: Date.now() - totalStart
    })
    if (!(limit > 0)) throw new Error('invalid duration')
    dec = stream.decoder()
    const dictionary = ffmpeg.Dictionary.from({
      threads: 'auto',
      ...(mode === 'key' ? { skip_frame: 'nokey' } : {})
    })
    try {
      dec.open(dictionary)
    } finally {
      dictionary.destroy()
    }
    packet = new ffmpeg.Packet()
    frame = new ffmpeg.Frame()
    let firstPts = null
    let nextSample = 0
    let decoded = 0
    let scaleMs = 0
    let packMs = 0
    let reachedLimit = false
    const decodeStart = Date.now()
    function receive() {
      while (dec.receiveFrame(frame)) {
        try {
          if (firstPts === null) firstPts = frame.pts
          const ptsS = (frame.pts - firstPts) * tb
          if (!Number.isFinite(ptsS)) throw new Error('invalid PTS')
          if (ptsS >= limit - 1e-6) {
            reachedLimit = true
            return
          }
          decoded++
          if (frames.length >= cap || ptsS + 1e-6 < nextSample) continue
          if (interval) nextSample = (Math.floor((ptsS + 1e-6) / interval) + 1) * interval
          const ratio = Math.min(1, settings.maxSide / Math.max(frame.width, frame.height))
          const width = Math.max(2, Math.round((frame.width * ratio) / 2) * 2)
          const height = Math.max(2, Math.round((frame.height * ratio) / 2) * 2)
          const s0 = Date.now()
          if (!scaler) {
            scaler = new ffmpeg.Scaler(
              frame.format,
              frame.width,
              frame.height,
              'RGB24',
              width,
              height
            )
            output = new ffmpeg.Frame()
            output.width = width
            output.height = height
            output.format = ffmpeg.constants.pixelFormats.RGB24
            output.alloc()
          }
          scaler.scale(frame, output)
          scaleMs += Date.now() - s0
          const p0 = Date.now()
          const pixels = new ffmpeg.Image('RGB24', width, height, 1)
          pixels.read(output)
          const ppm = Buffer.concat([Buffer.from(`P6\n${width} ${height}\n255\n`), pixels.data])
          frames.push({ ptsS, width, height, ppm })
          packMs += Date.now() - p0
        } finally {
          frame.unref()
        }
      }
    }
    while (!reachedLimit && fmt.readFrame(packet)) {
      try {
        if (packet.streamIndex === stream.index) {
          dec.sendPacket(packet)
          receive()
        }
      } finally {
        packet.unref()
      }
    }
    // Flush delayed B frames at EOF. Do not flush after the requested time limit.
    if (!reachedLimit) {
      packet.unref()
      dec.sendPacket(packet)
      receive()
    }
    record.decodeAndPrepareMs = Date.now() - decodeStart
    Object.assign(record, {
      decodedFrames: decoded,
      retainedFrames: frames.length,
      scaleMs,
      packMs,
      decodeDemuxMs: record.decodeAndPrepareMs - scaleMs - packMs,
      retainedBytes: frames.reduce((n, f) => n + f.ppm.length, 0),
      timestampsS: frames.map((f) => f.ptsS),
      outputWidth: frames[0]?.width,
      outputHeight: frames[0]?.height
    })
    if (!frames.length) throw new Error('zero sampled frames')
    return { frames, record }
  } finally {
    for (const value of [packet, frame, output, scaler, dec, fmt]) if (value) value.destroy()
    fs.closeSync(fd)
    record.preprocessingMs = Date.now() - totalStart
  }
}

module.exports = { extract, download, hashFile }
