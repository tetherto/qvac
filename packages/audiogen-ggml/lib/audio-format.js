'use strict'

// Output-format helpers for @qvac/audiogen-ggml.
//
// The native addon emits raw PCM (interleaved Int16 @ the engine sample rate).
// The requested container/encoding is applied here, at the JS boundary, mirroring
// how tts-ggml keeps the native side format-agnostic.
//
//   - `pcm`  : raw interleaved Int16 samples, dependency-free passthrough.
//   - `wav`  : 16-bit PCM WAV container, dependency-free (pure JS header).
//   - others : encoded with `bare-ffmpeg` (lazy-loaded), reusing the FFmpeg
//              build already vendored for @qvac/decoder-audio.
//
// `encode(pcm, formats, opts)` (a.k.a. `encodePcm`) accepts a single format or an
// array: one format in -> one file out, N formats in -> N files out.

// Output formats the addon can produce. Compressed ones require `bare-ffmpeg`
// with the matching encoder compiled in (see FFMPEG_FORMATS below).
const SUPPORTED_FORMATS = [
  'pcm',
  'wav',
  'flac',
  'alac',
  'aiff',
  'caf',
  'm4a',
  'aac',
  'opus',
  'ogg',
  'ac3',
  'wma',
  'mp2'
]

// FFmpeg encoding recipe per format: container (muxer), encoder name, target
// sample format, file extension, MIME type, and optional constraints.
//   - `rate`         : force this output sample rate (libopus only supports a
//                      fixed set; 48 kHz is the safe choice).
//   - `experimental` : the encoder is flagged experimental in FFmpeg and needs
//                      the "strict experimental" compliance flag (native vorbis).
const FFMPEG_FORMATS = {
  wav: {
    container: 'wav',
    encoder: 'pcm_s16le',
    sampleFormat: 'S16',
    extension: 'wav',
    mimeType: 'audio/wav'
  },
  flac: {
    container: 'flac',
    encoder: 'flac',
    sampleFormat: 'S16',
    extension: 'flac',
    mimeType: 'audio/flac'
  },
  m4a: {
    container: 'ipod',
    encoder: 'aac',
    sampleFormat: 'FLTP',
    extension: 'm4a',
    mimeType: 'audio/mp4'
  },
  aac: {
    container: 'adts',
    encoder: 'aac',
    sampleFormat: 'FLTP',
    extension: 'aac',
    mimeType: 'audio/aac'
  },
  opus: {
    container: 'opus',
    encoder: 'libopus',
    sampleFormat: 'S16',
    extension: 'opus',
    mimeType: 'audio/opus',
    rate: 48000
  },
  ogg: {
    container: 'ogg',
    encoder: 'vorbis',
    sampleFormat: 'FLTP',
    extension: 'ogg',
    mimeType: 'audio/ogg',
    experimental: true
  },
  // Apple Lossless (ALAC) in an MP4/iTunes container (.m4a).
  alac: {
    container: 'ipod',
    encoder: 'alac',
    sampleFormat: 'S16P',
    extension: 'm4a',
    mimeType: 'audio/mp4'
  },
  // Uncompressed 16-bit big-endian PCM in an AIFF container.
  aiff: {
    container: 'aiff',
    encoder: 'pcm_s16be',
    sampleFormat: 'S16',
    extension: 'aiff',
    mimeType: 'audio/aiff'
  },
  // Uncompressed 16-bit PCM in Apple's Core Audio Format container.
  caf: {
    container: 'caf',
    encoder: 'pcm_s16le',
    sampleFormat: 'S16',
    extension: 'caf',
    mimeType: 'audio/x-caf'
  },
  // Dolby Digital (AC-3).
  ac3: {
    container: 'ac3',
    encoder: 'ac3',
    sampleFormat: 'FLTP',
    extension: 'ac3',
    mimeType: 'audio/ac3'
  },
  // Windows Media Audio (WMA v2) in an ASF container.
  wma: {
    container: 'asf',
    encoder: 'wmav2',
    sampleFormat: 'FLTP',
    extension: 'wma',
    mimeType: 'audio/x-ms-wma'
  },
  // MPEG-1 Audio Layer II (legacy).
  mp2: {
    container: 'mp2',
    encoder: 'mp2',
    sampleFormat: 'S16',
    extension: 'mp2',
    mimeType: 'audio/mpeg'
  }
}

const MIME_TYPES = {
  pcm: 'audio/L16',
  wav: 'audio/wav',
  flac: 'audio/flac',
  alac: 'audio/mp4',
  aiff: 'audio/aiff',
  caf: 'audio/x-caf',
  m4a: 'audio/mp4',
  aac: 'audio/aac',
  opus: 'audio/opus',
  ogg: 'audio/ogg',
  ac3: 'audio/ac3',
  wma: 'audio/x-ms-wma',
  mp2: 'audio/mpeg'
}

function writeIntLE(buf, value, offset, byteLength) {
  for (let i = 0; i < byteLength; i++) {
    buf[offset + i] = value & 0xff
    value = Math.floor(value / 256)
  }
}

/**
 * Wrap interleaved Int16 PCM in a canonical 16-bit PCM WAV container.
 * Dependency-free (pure JS): builds the 44-byte header and prepends it.
 * @param {Buffer|Uint8Array} pcm Interleaved Int16 little-endian samples.
 * @param {Object} opts
 * @param {number} [opts.sampleRate=48000]
 * @param {number} [opts.channels=2]
 * @returns {Buffer}
 */
function pcmToWav(pcm, { sampleRate = 48000, channels = 2 } = {}) {
  const bytesPerSample = 2
  const blockAlign = channels * bytesPerSample
  const byteRate = sampleRate * blockAlign
  const dataSize = pcm.length
  const out = Buffer.alloc(44 + dataSize)

  out.write('RIFF', 0, 'ascii')
  writeIntLE(out, 36 + dataSize, 4, 4)
  out.write('WAVE', 8, 'ascii')

  out.write('fmt ', 12, 'ascii')
  writeIntLE(out, 16, 16, 4) // fmt chunk size
  writeIntLE(out, 1, 20, 2) // PCM
  writeIntLE(out, channels, 22, 2)
  writeIntLE(out, sampleRate, 24, 4)
  writeIntLE(out, byteRate, 28, 4)
  writeIntLE(out, blockAlign, 32, 2)
  writeIntLE(out, bytesPerSample * 8, 34, 2) // bits per sample

  out.write('data', 36, 'ascii')
  writeIntLE(out, dataSize, 40, 4)
  Buffer.from(pcm.buffer ? pcm.buffer : pcm, pcm.byteOffset || 0, dataSize).copy(out, 44)

  return out
}

// A seekable in-memory output sink for FFmpeg. MP4/M4A muxers seek back to patch
// the `moov` atom, so a naive append-only writer produces invalid files.
function createWriteIO(ffmpeg) {
  let buf = Buffer.alloc(64 * 1024)
  let pos = 0
  let size = 0

  const ensure = (need) => {
    if (need <= buf.length) return
    let cap = buf.length
    while (cap < need) cap *= 2
    const next = Buffer.alloc(cap)
    buf.copy(next)
    buf = next
  }

  const io = new ffmpeg.IOContext(64 * 1024, {
    onwrite: (chunk) => {
      ensure(pos + chunk.length)
      chunk.copy(buf, pos)
      pos += chunk.length
      if (pos > size) size = pos
      return chunk.length
    },
    onseek: (offset, whence) => {
      const AVSEEK_SIZE = 0x10000
      if (whence === AVSEEK_SIZE) return size
      let next
      if (whence === 0) next = offset
      else if (whence === 1) next = pos + offset
      else if (whence === 2) next = size + offset
      else return -1
      if (next < 0) return -1
      pos = next
      return pos
    }
  })

  return { io, getData: () => Buffer.from(buf.subarray(0, size)) }
}

// A read-only in-memory source for FFmpeg (feeds the decoder our WAV bytes).
function createReadIO(ffmpeg, source) {
  let offset = 0
  return new ffmpeg.IOContext(64 * 1024, {
    onread: (out, want) => {
      const n = Math.min(want, source.length - offset)
      if (n <= 0) return 0
      source.copy(out, 0, offset, offset + n)
      offset += n
      return n
    },
    onseek: (seekOffset, whence) => {
      const AVSEEK_SIZE = 0x10000
      if (whence === AVSEEK_SIZE) return source.length
      let next
      if (whence === 0) next = seekOffset
      else if (whence === 1) next = offset + seekOffset
      else if (whence === 2) next = source.length + seekOffset
      else return -1
      if (next < 0 || next > source.length) return -1
      offset = next
      return offset
    }
  })
}

let _ffmpeg = null
function loadFfmpeg() {
  if (_ffmpeg) return _ffmpeg
  try {
    // eslint-disable-next-line global-require
    _ffmpeg = require('bare-ffmpeg')
  } catch (err) {
    throw new Error(
      `Encoding to compressed formats requires "bare-ffmpeg" (a package dependency); it failed to load, which usually means a broken or incomplete install: ${err.message}`
    )
  }
  return _ffmpeg
}

/**
 * Transcode interleaved Int16 PCM to a compressed/container format via FFmpeg.
 * Pipeline: PCM -> in-memory WAV -> ffmpeg decode -> resample to the encoder's
 * required sample format/rate -> AudioFIFO (fixed frame sizing) -> encode -> mux.
 * @param {Buffer|Uint8Array} pcm
 * @param {string} format one of FFMPEG_FORMATS keys
 * @param {{sampleRate?: number, channels?: number}} opts
 * @returns {Buffer}
 */
function encodeWithFfmpeg(pcm, format, { sampleRate = 48000, channels = 2 } = {}) {
  // Fail fast on inputs the FFmpeg path can't represent: the layout picker below
  // only knows MONO/STEREO, and a bad rate or a PCM buffer that isn't a whole
  // number of interleaved Int16 frames would otherwise yield corrupt container
  // metadata or trip undefined behavior inside the bindings (AudioFIFO/layout).
  if (channels !== 1 && channels !== 2) {
    throw new Error(`encodeWithFfmpeg: channels must be 1 or 2, got ${channels}`)
  }
  if (!Number.isInteger(sampleRate) || sampleRate <= 0) {
    throw new Error(`encodeWithFfmpeg: sampleRate must be a positive integer, got ${sampleRate}`)
  }
  const bytesPerFrame = 2 * channels
  if (pcm.length % bytesPerFrame !== 0) {
    throw new Error(
      `encodeWithFfmpeg: PCM byte length (${pcm.length}) must be a multiple of ${bytesPerFrame} ` +
        `(2 bytes/sample x ${channels} channel(s))`
    )
  }
  const ffmpeg = loadFfmpeg()
  const C = ffmpeg.constants
  const spec = FFMPEG_FORMATS[format]
  const layout = channels === 1 ? C.channelLayouts.MONO : C.channelLayouts.STEREO
  const outRate = spec.rate || sampleRate
  const sampleFormat = C.sampleFormats[spec.sampleFormat]

  // --- decode side: wrap PCM as WAV so ffmpeg produces clean input frames ---
  const wav = pcmToWav(pcm, { sampleRate, channels })
  const inFmt = new ffmpeg.InputFormatContext(createReadIO(ffmpeg, wav))
  const inStream = inFmt.streams[0]
  const decoder = inStream.decoder()
  decoder.open()

  // --- encoder ---
  const encoder = new ffmpeg.Encoder(spec.encoder)
  const cc = new ffmpeg.CodecContext(encoder)
  cc.sampleRate = outRate
  cc.sampleFormat = sampleFormat
  cc.channelLayout = ffmpeg.ChannelLayout.from(layout)
  cc.timeBase = new ffmpeg.Rational(1, outRate)
  if (spec.experimental) {
    try {
      cc.setOption('strict', 'experimental')
    } catch {
      /* older bindings: option may already default to permissive */
    }
  }
  cc.open()
  const frameSize = cc.frameSize > 0 ? cc.frameSize : 4096

  // --- muxer (seekable in-memory) ---
  const sink = createWriteIO(ffmpeg)
  const ofc = new ffmpeg.OutputFormatContext(spec.container, sink.io)
  const ostream = ofc.createStream()
  ostream.codecParameters.fromContext(cc)
  ofc.writeHeader()

  // --- resample (input format/rate -> encoder format/rate) + FIFO framing ---
  const resampler = new ffmpeg.Resampler(
    inStream.codecParameters.sampleRate,
    inStream.codecParameters.channelLayout,
    inStream.codecParameters.format,
    outRate,
    layout,
    sampleFormat
  )
  const fifo = new ffmpeg.AudioFIFO(sampleFormat, channels, frameSize)
  const packet = new ffmpeg.Packet()
  let pts = 0

  const emit = (frame) => {
    cc.sendFrame(frame)
    while (cc.receivePacket(packet)) {
      packet.streamIndex = ostream.index
      packet.rescaleTimestamps(cc.timeBase, ostream.timeBase)
      ofc.writeFrame(packet)
      packet.unref()
    }
  }

  const drain = (flush) => {
    while (fifo.size >= frameSize || (flush && fifo.size > 0)) {
      const n = Math.min(frameSize, fifo.size)
      const frame = new ffmpeg.Frame()
      frame.format = sampleFormat
      frame.channelLayout = ffmpeg.ChannelLayout.from(layout)
      frame.sampleRate = outRate
      frame.nbSamples = n
      frame.alloc()
      fifo.read(frame, n)
      frame.pts = pts
      pts += n
      emit(frame)
    }
  }

  const pushResampled = (rawFrame) => {
    const out = new ffmpeg.Frame()
    out.channelLayout = ffmpeg.ChannelLayout.from(layout)
    out.format = sampleFormat
    out.sampleRate = outRate
    const inSamples = rawFrame ? rawFrame.nbSamples : 1024
    out.nbSamples = Math.ceil((inSamples * outRate) / inStream.codecParameters.sampleRate) + 1024
    const samples = new ffmpeg.Samples()
    samples.fill(out)
    const count = rawFrame ? resampler.convert(rawFrame, out) : resampler.flush(out)
    if (count > 0) {
      out.nbSamples = count
      fifo.write(out)
    }
    return count
  }

  const inPacket = new ffmpeg.Packet()
  const raw = new ffmpeg.Frame()
  while (inFmt.readFrame(inPacket)) {
    decoder.sendPacket(inPacket)
    while (decoder.receiveFrame(raw)) pushResampled(raw)
    inPacket.unref()
    drain(false)
  }
  while (pushResampled(null) > 0) {
    /* flush the resampler's internal buffer */
  }
  drain(true)
  emit(null) // flush the encoder
  ofc.writeTrailer()

  return sink.getData()
}

// Encode a single format. `pcm`/`wav` stay dependency-free; the rest go through
// FFmpeg. Returns `{ format, data, extension, mimeType }`.
function encodeOne(pcm, format, opts) {
  const fmt = String(format || 'wav').toLowerCase()
  if (!SUPPORTED_FORMATS.includes(fmt)) {
    throw new Error(
      `Unsupported outputFormat "${format}". Supported: ${SUPPORTED_FORMATS.join(', ')}.`
    )
  }
  if (fmt === 'pcm') {
    return { format: 'pcm', data: Buffer.from(pcm), extension: 'pcm', mimeType: MIME_TYPES.pcm }
  }
  if (fmt === 'wav') {
    return { format: 'wav', data: pcmToWav(pcm, opts), extension: 'wav', mimeType: MIME_TYPES.wav }
  }
  return {
    format: fmt,
    data: encodeWithFfmpeg(pcm, fmt, opts),
    extension: FFMPEG_FORMATS[fmt].extension,
    mimeType: FFMPEG_FORMATS[fmt].mimeType
  }
}

/**
 * Encode interleaved Int16 PCM into one or more output formats.
 * @param {Buffer|Uint8Array} pcm interleaved Int16 little-endian samples.
 * @param {string|string[]} [formats='wav'] a single format or an array of them.
 *   One format in -> one file out; N formats in -> N files out.
 * @param {{sampleRate?: number, channels?: number}} [opts]
 * @returns {{format: string, data: Buffer, extension: string, mimeType: string}
 *          | Array<{format: string, data: Buffer, extension: string, mimeType: string}>}
 *   A single result for a string input, or an array (input order) for an array input.
 */
function encodePcm(pcm, formats = 'wav', opts = {}) {
  if (Array.isArray(formats)) {
    return formats.map((format) => encodeOne(pcm, format, opts))
  }
  return encodeOne(pcm, formats, opts)
}

module.exports = { SUPPORTED_FORMATS, FFMPEG_FORMATS, MIME_TYPES, pcmToWav, encodePcm }
