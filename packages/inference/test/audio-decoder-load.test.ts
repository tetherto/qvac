import test from 'brittle'
import { FFmpegDecoder } from '@qvac/decoder-audio'
import { ConfigValidationFailedError } from '@/errors/index'
import { decodeAudioToStream } from '@/utils/audio/decoder'

const missingFFmpeg = Object.assign(new Error("Cannot find module 'bare-ffmpeg'"), {
  code: 'MODULE_NOT_FOUND',
  specifier: 'bare-ffmpeg'
})

for (const [name, loadError] of [
  ['missing FFmpeg', missingFFmpeg],
  [
    'another missing dependency',
    Object.assign(new Error("Cannot find module 'other-dependency' imported from bare-ffmpeg"), {
      code: 'MODULE_NOT_FOUND',
      specifier: 'other-dependency'
    })
  ],
  ['another decoder failure', new Error('bare-ffmpeg failed to initialize')]
] as const) {
  test(`audio decoder load: ${name}`, async (t) => {
    const originalLoad = FFmpegDecoder.prototype.load
    const originalUnload = FFmpegDecoder.prototype.unload
    let unloads = 0
    FFmpegDecoder.prototype.load = async function () {
      throw loadError
    }
    FFmpegDecoder.prototype.unload = async function () {
      unloads++
    }
    t.teardown(() => {
      FFmpegDecoder.prototype.load = originalLoad
      FFmpegDecoder.prototype.unload = originalUnload
    })

    try {
      await decodeAudioToStream('audio.wav')
      t.fail('expected decoding to reject')
    } catch (error) {
      if (loadError === missingFFmpeg) {
        t.ok(
          error instanceof ConfigValidationFailedError,
          'reports a structured configuration error'
        )
        t.is((error as Error).cause, loadError, 'preserves the original loader error')
        t.ok((error as Error).message.includes('includeAudioDecoder'), 'names the bundle option')
      } else {
        t.is(error, loadError, 'preserves unrelated failures unchanged')
      }
    }
    t.is(unloads, 1, 'cleans up the decoder once')
  })
}
