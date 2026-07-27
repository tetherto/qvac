'use strict'

// Checks for the output-format helpers (lib/audio-format.js): the WAV container
// bytes, the raw-PCM passthrough, multi-format encoding, and the compressed
// formats produced via bare-ffmpeg (validated by their container magic bytes).
// Runs under bare (brittle-bare), where bare-ffmpeg is available.

const test = require('brittle')
const { encodePcm, pcmToWav, SUPPORTED_FORMATS, MIME_TYPES } = require('../../lib/audio-format')

// Four interleaved Int16 samples (8 bytes) as a little-endian byte buffer.
function samplePcm() {
  const pcm = Buffer.alloc(8)
  pcm.writeInt16LE(0, 0)
  pcm.writeInt16LE(1000, 2)
  pcm.writeInt16LE(-1000, 4)
  pcm.writeInt16LE(32767, 6)
  return pcm
}

// ~0.2 s of 440 Hz stereo tone @ 44.1 kHz — enough for the lossy encoders to
// emit at least one full frame.
function tonePcm({ sampleRate = 44100, channels = 2, seconds = 0.2 } = {}) {
  const n = Math.floor(sampleRate * seconds)
  const pcm = Buffer.alloc(n * channels * 2)
  for (let i = 0; i < n; i++) {
    const v = Math.round(Math.sin((2 * Math.PI * 440 * i) / sampleRate) * 12000)
    for (let c = 0; c < channels; c++) pcm.writeInt16LE(v, (i * channels + c) * 2)
  }
  return pcm
}

function readTag(buf, offset) {
  return buf.toString('ascii', offset, offset + 4)
}

test('SUPPORTED_FORMATS: the full allowed set', (t) => {
  t.alike(SUPPORTED_FORMATS.slice().sort(), [
    'aac',
    'ac3',
    'aiff',
    'alac',
    'caf',
    'flac',
    'm4a',
    'mp2',
    'ogg',
    'opus',
    'pcm',
    'wav',
    'wma'
  ])
})

test('pcmToWav: canonical 44-byte header for the default 48 kHz stereo', (t) => {
  const pcm = samplePcm()
  const wav = pcmToWav(pcm)

  t.is(wav.length, 44 + pcm.length, 'header + data')

  // RIFF / WAVE / fmt / data chunk tags.
  t.is(readTag(wav, 0), 'RIFF')
  t.is(readTag(wav, 8), 'WAVE')
  t.is(readTag(wav, 12), 'fmt ')
  t.is(readTag(wav, 36), 'data')

  t.is(wav.readUInt32LE(4), 36 + pcm.length, 'RIFF chunk size = 36 + data')
  t.is(wav.readUInt32LE(16), 16, 'fmt chunk size')
  t.is(wav.readUInt16LE(20), 1, 'PCM format tag')
  t.is(wav.readUInt16LE(22), 2, 'channels = 2 (default)')
  t.is(wav.readUInt32LE(24), 48000, 'sample rate = 48000 (default)')
  t.is(wav.readUInt16LE(34), 16, 'bits per sample')

  const blockAlign = 2 * 2 // channels * bytesPerSample
  t.is(wav.readUInt16LE(32), blockAlign, 'block align')
  t.is(wav.readUInt32LE(28), 48000 * blockAlign, 'byte rate')
  t.is(wav.readUInt32LE(40), pcm.length, 'data chunk size')

  // The PCM payload is copied verbatim after the 44-byte header.
  t.alike(Uint8Array.from(wav.subarray(44)), Uint8Array.from(pcm))
})

test('pcmToWav: honours sampleRate / channels overrides', (t) => {
  const pcm = samplePcm()
  const wav = pcmToWav(pcm, { sampleRate: 44100, channels: 1 })
  const blockAlign = 1 * 2

  t.is(wav.readUInt16LE(22), 1, 'channels = 1')
  t.is(wav.readUInt32LE(24), 44100, 'sample rate = 44100')
  t.is(wav.readUInt16LE(32), blockAlign, 'block align follows channels')
  t.is(wav.readUInt32LE(28), 44100 * blockAlign, 'byte rate follows overrides')
})

test('encodePcm: wav wraps, pcm passes through, default is wav', (t) => {
  const pcm = samplePcm()

  const wav = encodePcm(pcm, 'wav')
  t.is(wav.format, 'wav')
  t.is(wav.extension, 'wav')
  t.is(wav.mimeType, MIME_TYPES.wav)
  t.is(readTag(wav.data, 0), 'RIFF')

  const raw = encodePcm(pcm, 'pcm')
  t.is(raw.format, 'pcm')
  t.is(raw.extension, 'pcm')
  t.alike(Uint8Array.from(raw.data), Uint8Array.from(pcm), 'pcm is a verbatim copy')

  const def = encodePcm(pcm)
  t.is(def.extension, 'wav', 'default format is wav')
})

test('encodePcm: an array of formats yields one result per format, in order', (t) => {
  const pcm = tonePcm()
  const results = encodePcm(pcm, ['wav', 'flac', 'pcm'], { sampleRate: 44100, channels: 2 })

  t.ok(Array.isArray(results), 'array in -> array out')
  t.is(results.length, 3)
  t.alike(
    results.map((r) => r.format),
    ['wav', 'flac', 'pcm'],
    'results preserve the requested order'
  )
  for (const r of results) {
    t.ok(r.data.length > 0, `${r.format} produced bytes`)
    t.is(r.mimeType, MIME_TYPES[r.format])
  }
})

test('encodePcm: compressed formats produce valid containers (magic bytes)', (t) => {
  const pcm = tonePcm()
  const opts = { sampleRate: 44100, channels: 2 }

  const flac = encodePcm(pcm, 'flac', opts)
  t.is(readTag(flac.data, 0), 'fLaC', 'flac stream marker')

  const m4a = encodePcm(pcm, 'm4a', opts)
  t.is(readTag(m4a.data, 4), 'ftyp', 'm4a/mp4 ftyp box')
  t.is(m4a.mimeType, 'audio/mp4')

  const aac = encodePcm(pcm, 'aac', opts)
  t.is(aac.data[0], 0xff, 'adts sync word byte 0')
  t.is(aac.data[1] & 0xf0, 0xf0, 'adts sync word byte 1')

  const opus = encodePcm(pcm, 'opus', opts)
  t.is(readTag(opus.data, 0), 'OggS', 'opus in ogg container')

  const ogg = encodePcm(pcm, 'ogg', opts)
  t.is(readTag(ogg.data, 0), 'OggS', 'vorbis in ogg container')

  const alac = encodePcm(pcm, 'alac', opts)
  t.is(readTag(alac.data, 4), 'ftyp', 'alac in mp4/m4a ftyp box')
  t.is(alac.mimeType, 'audio/mp4')

  const aiff = encodePcm(pcm, 'aiff', opts)
  t.is(readTag(aiff.data, 0), 'FORM', 'aiff FORM chunk')

  const caf = encodePcm(pcm, 'caf', opts)
  t.is(readTag(caf.data, 0), 'caff', 'core audio format marker')

  const ac3 = encodePcm(pcm, 'ac3', opts)
  t.is(ac3.data[0], 0x0b, 'ac3 sync word byte 0')
  t.is(ac3.data[1], 0x77, 'ac3 sync word byte 1')

  const wma = encodePcm(pcm, 'wma', opts)
  t.is(wma.data[0], 0x30, 'asf header guid byte 0')
  t.is(wma.data[1], 0x26, 'asf header guid byte 1')

  const mp2 = encodePcm(pcm, 'mp2', opts)
  t.is(mp2.data[0], 0xff, 'mp2 frame sync byte 0')
  t.is(mp2.data[1] & 0xe0, 0xe0, 'mp2 frame sync byte 1')
})

test('encodePcm: unknown format throws with a helpful message', (t) => {
  t.exception(() => encodePcm(samplePcm(), 'mp3'), /Unsupported outputFormat/)
})
