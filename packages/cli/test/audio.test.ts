import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  DEFAULT_SPEECH_FORMAT,
  DEFAULT_SAMPLE_RATE,
  mapResponseFormat,
  pcmContentType,
  resolveSampleRate,
  int16SamplesToBuffer,
  buildWavHeader,
  buildWavBuffer,
  speechAliasKey
} from '../src/serve/audio.js'
import { parseServeConfig } from '../src/serve/config.js'
import { speechEncodeArgs, ENCODED_SPEECH_FORMATS } from '../src/serve/lib/audio-transcode.js'

describe('mapResponseFormat', () => {
  it('returns the documented default for missing input', () => {
    const result = mapResponseFormat(undefined)
    assert.equal(result.kind, 'native')
    if (result.kind === 'native') {
      assert.equal(result.format, DEFAULT_SPEECH_FORMAT)
      assert.equal(result.contentType, 'audio/wav')
    }
  })

  it('returns the documented default for empty string', () => {
    const result = mapResponseFormat('')
    assert.equal(result.kind, 'native')
  })

  it('accepts wav and pcm as native formats', () => {
    const wav = mapResponseFormat('wav')
    const pcm = mapResponseFormat('pcm')
    assert.equal(wav.kind, 'native')
    assert.equal(pcm.kind, 'native')
    if (wav.kind === 'native') {
      assert.equal(wav.format, 'wav')
      assert.equal(wav.contentType, 'audio/wav')
    }
    // PCM content-type is rebuilt with the sample rate at the call site
    // (RFC 2586 audio/L16 requires it). The mapping only exposes the kind.
    if (pcm.kind === 'native') {
      assert.equal(pcm.format, 'pcm')
    }
  })

  it('is case-insensitive for native formats', () => {
    const result = mapResponseFormat('WAV')
    assert.equal(result.kind, 'native')
    if (result.kind === 'native') assert.equal(result.format, 'wav')
  })

  it('flags mp3/opus/aac/flac as transcoded with a Content-Type', () => {
    const expected: Record<string, string> = {
      mp3: 'audio/mpeg',
      opus: 'audio/ogg',
      aac: 'audio/aac',
      flac: 'audio/flac'
    }
    for (const format of Object.keys(expected)) {
      const result = mapResponseFormat(format)
      assert.equal(result.kind, 'transcoded', `expected ${format} to be transcoded`)
      if (result.kind === 'transcoded') {
        assert.equal(result.format, format)
        assert.equal(result.contentType, expected[format])
      }
    }
  })

  it('is case-insensitive for encoded formats', () => {
    const result = mapResponseFormat('MP3')
    assert.equal(result.kind, 'transcoded')
    if (result.kind === 'transcoded') assert.equal(result.format, 'mp3')
  })

  it('rejects unknown formats as invalid', () => {
    const result = mapResponseFormat('mp4')
    assert.equal(result.kind, 'invalid')
  })

  it('rejects non-string input', () => {
    const result = mapResponseFormat(42)
    assert.equal(result.kind, 'invalid')
  })
})

describe('resolveSampleRate', () => {
  it('returns the default when config is missing', () => {
    assert.equal(resolveSampleRate(undefined), DEFAULT_SAMPLE_RATE)
  })

  it('returns the default for empty config', () => {
    assert.equal(resolveSampleRate({}), DEFAULT_SAMPLE_RATE)
  })

  it('honors an explicit sampleRate override', () => {
    assert.equal(resolveSampleRate({ sampleRate: 16000 }), 16000)
  })

  it('floors a non-integer override to keep WAV header math sane', () => {
    assert.equal(resolveSampleRate({ sampleRate: 22050.7 }), 22050)
  })

  it('ignores zero/negative/non-finite overrides', () => {
    assert.equal(resolveSampleRate({ sampleRate: 0 }), DEFAULT_SAMPLE_RATE)
    assert.equal(resolveSampleRate({ sampleRate: -1 }), DEFAULT_SAMPLE_RATE)
    assert.equal(resolveSampleRate({ sampleRate: Number.NaN }), DEFAULT_SAMPLE_RATE)
  })

  it('maps Chatterbox to 24000 Hz', () => {
    assert.equal(resolveSampleRate({ ttsEngine: 'chatterbox' }), 24000)
  })

  it('maps Supertonic to 44100 Hz', () => {
    assert.equal(resolveSampleRate({ ttsEngine: 'supertonic' }), 44100)
  })

  it('is case-insensitive on engine name', () => {
    assert.equal(resolveSampleRate({ ttsEngine: 'CHATTERBOX' }), 24000)
  })

  it('falls back to the default for unknown engines', () => {
    assert.equal(resolveSampleRate({ ttsEngine: 'mysteryvoice' }), DEFAULT_SAMPLE_RATE)
  })

  it('prefers explicit sampleRate over engine inference', () => {
    assert.equal(resolveSampleRate({ ttsEngine: 'chatterbox', sampleRate: 16000 }), 16000)
  })
})

describe('int16SamplesToBuffer', () => {
  it('encodes samples as little-endian Int16', () => {
    const buf = int16SamplesToBuffer([0, 1, -1, 32767, -32768])
    assert.equal(buf.length, 10)
    assert.equal(buf.readInt16LE(0), 0)
    assert.equal(buf.readInt16LE(2), 1)
    assert.equal(buf.readInt16LE(4), -1)
    assert.equal(buf.readInt16LE(6), 32767)
    assert.equal(buf.readInt16LE(8), -32768)
  })

  it('clamps out-of-range values', () => {
    const buf = int16SamplesToBuffer([40000, -40000])
    assert.equal(buf.readInt16LE(0), 32767)
    assert.equal(buf.readInt16LE(2), -32768)
  })

  it('rounds fractional samples', () => {
    const buf = int16SamplesToBuffer([1.4, 1.6, -1.5])
    assert.equal(buf.readInt16LE(0), 1)
    assert.equal(buf.readInt16LE(2), 2)
    assert.equal(buf.readInt16LE(4), -1)
  })

  it('returns an empty buffer for empty input', () => {
    assert.equal(int16SamplesToBuffer([]).length, 0)
  })
})

describe('buildWavHeader', () => {
  it('writes a 44-byte RIFF/WAVE header for mono 16-bit PCM', () => {
    const header = buildWavHeader(0, 24000)
    assert.equal(header.length, 44)
    assert.equal(header.toString('ascii', 0, 4), 'RIFF')
    assert.equal(header.toString('ascii', 8, 12), 'WAVE')
    assert.equal(header.toString('ascii', 12, 16), 'fmt ')
    assert.equal(header.toString('ascii', 36, 40), 'data')

    assert.equal(header.readUInt32LE(16), 16) // fmt chunk size
    assert.equal(header.readUInt16LE(20), 1) // PCM format
    assert.equal(header.readUInt16LE(22), 1) // mono
    assert.equal(header.readUInt32LE(24), 24000)
    assert.equal(header.readUInt32LE(28), 24000 * 2)
    assert.equal(header.readUInt16LE(32), 2) // block align
    assert.equal(header.readUInt16LE(34), 16) // bits per sample
  })

  it('records data length and computes RIFF size correctly', () => {
    const header = buildWavHeader(1000, 44100)
    assert.equal(header.readUInt32LE(40), 1000)
    assert.equal(header.readUInt32LE(4), 36 + 1000)
    assert.equal(header.readUInt32LE(28), 44100 * 2)
  })
})

describe('buildWavBuffer', () => {
  it('concatenates header and PCM data', () => {
    const samples = [0, 1, 2, 3]
    const wav = buildWavBuffer(samples, 24000)
    assert.equal(wav.length, 44 + samples.length * 2)
    assert.equal(wav.toString('ascii', 0, 4), 'RIFF')
    assert.equal(wav.readInt16LE(44), 0)
    assert.equal(wav.readInt16LE(46), 1)
    assert.equal(wav.readInt16LE(48), 2)
    assert.equal(wav.readInt16LE(50), 3)
  })

  it('records the actual PCM byte length in the header', () => {
    const samples = new Array(100).fill(123)
    const wav = buildWavBuffer(samples, 24000)
    assert.equal(wav.readUInt32LE(40), 200)
  })
})

describe('speechAliasKey', () => {
  it('joins model and voice with a hyphen', () => {
    assert.equal(speechAliasKey('tts-supertonic', 'alloy'), 'tts-supertonic-alloy')
  })
})

describe('pcmContentType', () => {
  it('emits an RFC 2586 audio/L16 type with rate and channels', () => {
    assert.equal(pcmContentType(24000), 'audio/L16; rate=24000; channels=1')
    assert.equal(pcmContentType(44100), 'audio/L16; rate=44100; channels=1')
  })
})

describe('speechEncodeArgs', () => {
  it('reads WAV from stdin and writes the container to stdout for every format', () => {
    for (const format of ENCODED_SPEECH_FORMATS) {
      const args = speechEncodeArgs(format)
      assert.equal(args[0], '-hide_banner')
      assert.ok(args.includes('-nostdin'))
      // input on pipe:0, output on pipe:1
      assert.equal(args[args.indexOf('-i') + 1], 'pipe:0')
      assert.equal(args[args.length - 1], 'pipe:1')
      // an explicit audio codec is selected
      assert.ok(args.includes('-c:a'), `${format} should set -c:a`)
    }
  })

  it('selects the expected codec/container per format', () => {
    assert.deepEqual(tail(speechEncodeArgs('mp3')), ['-c:a', 'libmp3lame', '-f', 'mp3', 'pipe:1'])
    assert.deepEqual(tail(speechEncodeArgs('opus')), ['-c:a', 'libopus', '-f', 'ogg', 'pipe:1'])
    assert.deepEqual(tail(speechEncodeArgs('aac')), ['-c:a', 'aac', '-f', 'adts', 'pipe:1'])
    assert.deepEqual(tail(speechEncodeArgs('flac')), ['-c:a', 'flac', '-f', 'flac', 'pipe:1'])
  })
})

function tail(args: string[]): string[] {
  return args.slice(args.indexOf('-c:a'))
}

describe('parseServeConfig — openai.audio.speech.voices', () => {
  it('normalizes voice keys to lowercase', async () => {
    const cfg = await parseServeConfig(
      {
        serve: {
          models: {},
          openai: {
            audio: {
              speech: {
                voices: { Alloy: 'tts-a', ECHO: 'tts-b' }
              }
            }
          }
        }
      },
      {}
    )
    assert.equal(cfg.openai.audio.speech.voices?.alloy, 'tts-a')
    assert.equal(cfg.openai.audio.speech.voices?.echo, 'tts-b')
  })

  it('rejects a non-object voices value', () => {
    assert.throws(
      () =>
        parseServeConfig(
          {
            serve: {
              models: {},
              openai: { audio: { speech: { voices: ['alloy'] } } }
            }
          },
          {}
        ),
      /serve\.openai\.audio\.speech\.voices must be a JSON object/
    )
  })
})

describe('parseServeConfig — openai.audio.speech.maxInputChars', () => {
  it('defaults to 4096 when unset', async () => {
    const cfg = await parseServeConfig({ serve: { models: {} } }, {})
    assert.equal(cfg.openai.audio.speech.maxInputChars, 4096)
  })

  it('accepts an explicit positive integer', async () => {
    const cfg = await parseServeConfig(
      { serve: { models: {}, openai: { audio: { speech: { maxInputChars: 1024 } } } } },
      {}
    )
    assert.equal(cfg.openai.audio.speech.maxInputChars, 1024)
  })

  it('treats null as "no cap"', async () => {
    const cfg = await parseServeConfig(
      { serve: { models: {}, openai: { audio: { speech: { maxInputChars: null } } } } },
      {}
    )
    assert.equal(cfg.openai.audio.speech.maxInputChars, null)
  })

  it('rejects non-integer or non-positive values', () => {
    for (const bad of [0, -1, 1.5, '4096', true]) {
      assert.throws(
        () =>
          parseServeConfig(
            {
              serve: {
                models: {},
                openai: { audio: { speech: { maxInputChars: bad as unknown as number } } }
              }
            },
            {}
          ),
        /serve\.openai\.audio\.speech\.maxInputChars must be a positive integer or null/
      )
    }
  })
})
