'use strict'

// Original, deterministic footage generated in memory. No external files or codecs are installed.
const ffmpeg = require('bare-ffmpeg')

function createVideo({
  fps = 10,
  frames = 40,
  gop = 5,
  bFrames = 2,
  rotation = 0,
  audio = false
} = {}) {
  const width = 64
  const height = 48
  const storage = Buffer.alloc(4 * 1024 * 1024)
  let offset = 0
  let size = 0
  const io = new ffmpeg.IOContext(4096, {
    onwrite(buffer) {
      if (offset + buffer.length > storage.length) throw new Error('Fixture exceeds allocation')
      buffer.copy(storage, offset)
      offset += buffer.length
      size = Math.max(size, offset)
      return buffer.length
    },
    onseek(delta, whence) {
      if (whence & 0x10000) return size
      const next = whence === 0 ? delta : whence === 1 ? offset + delta : size + delta
      if (next < 0 || next > storage.length) return -1
      offset = next
      return offset
    }
  })
  const encoder = new ffmpeg.CodecContext(new ffmpeg.Encoder('mpeg4'))
  const input = new ffmpeg.Frame()
  const output = new ffmpeg.Frame()
  const packet = new ffmpeg.Packet()
  const scaler = new ffmpeg.Scaler('RGB24', width, height, 'YUV420P', width, height)
  const muxer = new ffmpeg.OutputFormatContext('mp4', io)
  const audioEncoder = audio ? new ffmpeg.CodecContext(new ffmpeg.Encoder('aac')) : null
  const audioFrame = audio ? new ffmpeg.Frame() : null
  try {
    encoder.width = width
    encoder.height = height
    encoder.pixelFormat = ffmpeg.constants.pixelFormats.YUV420P
    encoder.timeBase = new ffmpeg.Rational(1, fps)
    encoder.frameRate = new ffmpeg.Rational(fps, 1)
    encoder.gopSize = gop
    encoder.flags |= 1 << 22 // AV_CODEC_FLAG_GLOBAL_HEADER
    const options = ffmpeg.Dictionary.from({ bf: String(bFrames) })
    try {
      encoder.open(options)
    } finally {
      options.destroy()
    }
    let audioStream = null
    if (audio) {
      audioEncoder.sampleRate = 16000
      audioEncoder.sampleFormat = ffmpeg.constants.sampleFormats.FLTP
      audioEncoder.channelLayout = 'MONO'
      audioEncoder.timeBase = new ffmpeg.Rational(1, 16000)
      audioEncoder.flags |= 1 << 22
      audioEncoder.open()
      audioStream = muxer.createStream() // Audio deliberately precedes the video stream.
      audioStream.codecParameters.fromContext(audioEncoder)
      audioStream.timeBase = audioEncoder.timeBase
    }
    const stream = muxer.createStream()
    stream.codecParameters.fromContext(encoder)
    stream.timeBase = encoder.timeBase
    muxer.writeHeader()
    if (audio) {
      const samples = new ffmpeg.Samples()
      audioFrame.format = audioEncoder.sampleFormat
      audioFrame.sampleRate = audioEncoder.sampleRate
      audioFrame.channelLayout = audioEncoder.channelLayout
      audioFrame.nbSamples = audioEncoder.frameSize
      samples.fill(audioFrame)
      samples.data.fill(0)
      function drainAudio() {
        while (audioEncoder.receivePacket(packet)) {
          packet.streamIndex = audioStream.index
          packet.rescaleTimestamps(audioEncoder.timeBase, audioStream.timeBase)
          muxer.writeFrame(packet)
          packet.unref()
        }
      }
      for (let i = 0; i < (frames / fps) * 16000; i += audioFrame.nbSamples) {
        audioFrame.pts = i
        audioEncoder.sendFrame(audioFrame)
        drainAudio()
      }
      audioEncoder.sendFrame(null)
      drainAudio()
    }
    const rgb = new ffmpeg.Image('RGB24', width, height)
    const yuv = new ffmpeg.Image('YUV420P', width, height)
    input.width = output.width = width
    input.height = output.height = height
    input.format = ffmpeg.constants.pixelFormats.RGB24
    output.format = ffmpeg.constants.pixelFormats.YUV420P
    rgb.fill(input)
    yuv.fill(output)
    let packetsWritten = 0
    function drain() {
      while (encoder.receivePacket(packet)) {
        packet.streamIndex = stream.index
        packet.duration = 1
        packet.rescaleTimestamps(encoder.timeBase, stream.timeBase)
        muxer.writeFrame(packet)
        packetsWritten++
        packet.unref()
      }
    }
    for (let i = 0; i < frames; i++) {
      // Four distinguishable corners; the blue component also changes over time.
      for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
          const p = (y * width + x) * 3
          rgb.data[p] = x < width / 2 ? 220 : 20
          rgb.data[p + 1] = y < height / 2 ? 220 : 20
          rgb.data[p + 2] = Math.floor((i * 200) / frames)
        }
      }
      scaler.scale(input, output)
      output.pts = i
      encoder.sendFrame(output)
      drain()
    }
    encoder.sendFrame(null)
    drain()
    if (packetsWritten !== frames) {
      throw new Error(`Fixture encoded ${packetsWritten}/${frames} frames`)
    }
    muxer.writeTrailer()
    const bytes = Buffer.from(storage.subarray(0, size))
    if (rotation) setRotation(bytes, rotation)
    return bytes
  } finally {
    muxer.destroy()
    io.destroy()
    scaler.destroy()
    packet.destroy()
    output.destroy()
    input.destroy()
    encoder.destroy()
    audioFrame?.destroy()
    audioEncoder?.destroy()
  }
}

function setRotation(bytes, degrees) {
  function visit(start, end) {
    for (let offset = start; offset + 8 <= end;) {
      const size = bytes.readUInt32BE(offset)
      const type = bytes.toString('ascii', offset + 4, offset + 8)
      if (size < 8 || offset + size > end) throw new Error('Invalid generated MP4 box')
      if (type === 'moov' || type === 'trak') visit(offset + 8, offset + size)
      if (type === 'tkhd') {
        if (bytes[offset + 8] !== 0) throw new Error('Expected v0 tkhd')
        const matrix =
          degrees === 90 ? [0, 1, -1, 0] : degrees === 180 ? [-1, 0, 0, -1] : [0, -1, 1, 0]
        for (const [index, value] of matrix.entries()) {
          bytes.writeInt32BE(value * 65536, offset + [48, 52, 60, 64][index])
        }
      }
      offset += size
    }
  }
  visit(0, bytes.length)
}

async function collectFrames(decoder, input, options) {
  const frames = []
  for await (const frame of decoder.frames(input, options)) frames.push(frame)
  return frames
}

module.exports = { createVideo, collectFrames }
