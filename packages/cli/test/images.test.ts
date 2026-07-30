import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  parseImageSize,
  extractImageGenerationParams,
  logImageUnsupportedParams,
  assertSupportedImageOutputParams,
  coerceMultipartFields,
  extractImageEditParams,
  logImageEditExtraWarnings,
  InvalidImagePromptError,
  InvalidImageSizeError,
  InvalidImageBatchCountError,
  InvalidImageStrengthError,
  UnsupportedImageOutputError
} from '../src/serve/schemas/images.js'

describe('parseImageSize', () => {
  it('returns null for undefined / null / empty', () => {
    assert.equal(parseImageSize(undefined), null)
    assert.equal(parseImageSize(null), null)
    assert.equal(parseImageSize(''), null)
  })

  it('returns { auto: true } for "auto"', () => {
    assert.deepEqual(parseImageSize('auto'), { auto: true })
  })

  it('parses "WIDTHxHEIGHT" multiples of 8', () => {
    assert.deepEqual(parseImageSize('1024x1024'), { width: 1024, height: 1024 })
    assert.deepEqual(parseImageSize('1536x1024'), { width: 1536, height: 1024 })
    assert.deepEqual(parseImageSize('1024x1536'), { width: 1024, height: 1536 })
  })

  it('throws on non-multiple-of-8 dimensions', () => {
    assert.throws(() => parseImageSize('1023x1024'), InvalidImageSizeError)
    assert.throws(() => parseImageSize('1024x1023'), InvalidImageSizeError)
  })

  it('throws on malformed strings', () => {
    assert.throws(() => parseImageSize('1024'), InvalidImageSizeError)
    assert.throws(() => parseImageSize('big'), InvalidImageSizeError)
    assert.throws(() => parseImageSize('1024X1024'), InvalidImageSizeError)
    assert.throws(() => parseImageSize('1024x'), InvalidImageSizeError)
  })

  it('throws on zero or negative dimensions', () => {
    assert.throws(() => parseImageSize('0x1024'), InvalidImageSizeError)
  })

  it('throws on non-string values', () => {
    assert.throws(() => parseImageSize(1024 as unknown as string), InvalidImageSizeError)
    assert.throws(() => parseImageSize({} as unknown as string), InvalidImageSizeError)
  })
})

describe('extractImageGenerationParams', () => {
  it('requires prompt', () => {
    assert.throws(() => extractImageGenerationParams({}, 'm'), InvalidImagePromptError)
    assert.throws(() => extractImageGenerationParams({ prompt: '' }, 'm'), InvalidImagePromptError)
    assert.throws(() => extractImageGenerationParams({ prompt: 123 }, 'm'), InvalidImagePromptError)
  })

  it('returns minimal params for prompt + model', () => {
    const params = extractImageGenerationParams({ prompt: 'a cat' }, 'sdk-model-1')
    assert.equal(params.modelId, 'sdk-model-1')
    assert.equal(params.prompt, 'a cat')
    assert.equal(params.width, undefined)
    assert.equal(params.height, undefined)
    assert.equal(params.batch_count, undefined)
    assert.equal(params.seed, undefined)
  })

  it('passes width/height when size is "WxH"', () => {
    const params = extractImageGenerationParams({ prompt: 'p', size: '1024x1536' }, 'm')
    assert.equal(params.width, 1024)
    assert.equal(params.height, 1536)
  })

  it('omits width/height when size is "auto"', () => {
    const params = extractImageGenerationParams({ prompt: 'p', size: 'auto' }, 'm')
    assert.equal(params.width, undefined)
    assert.equal(params.height, undefined)
  })

  it('forwards integer seed', () => {
    const params = extractImageGenerationParams({ prompt: 'p', seed: 42 }, 'm')
    assert.equal(params.seed, 42)
  })

  it('ignores non-integer seed', () => {
    const params = extractImageGenerationParams({ prompt: 'p', seed: 1.5 }, 'm')
    assert.equal(params.seed, undefined)
  })

  it('forwards positive integer n unchanged (no upper clamp)', () => {
    assert.equal(extractImageGenerationParams({ prompt: 'p', n: 1 }, 'm').batch_count, 1)
    assert.equal(extractImageGenerationParams({ prompt: 'p', n: 4 }, 'm').batch_count, 4)
    assert.equal(extractImageGenerationParams({ prompt: 'p', n: 10 }, 'm').batch_count, 10)
    assert.equal(extractImageGenerationParams({ prompt: 'p', n: 64 }, 'm').batch_count, 64)
  })

  it('throws InvalidImageBatchCountError on n < 1, non-integer, or non-number', () => {
    assert.throws(
      () => extractImageGenerationParams({ prompt: 'p', n: 0 }, 'm'),
      InvalidImageBatchCountError
    )
    assert.throws(
      () => extractImageGenerationParams({ prompt: 'p', n: -3 }, 'm'),
      InvalidImageBatchCountError
    )
    assert.throws(
      () => extractImageGenerationParams({ prompt: 'p', n: 1.5 }, 'm'),
      InvalidImageBatchCountError
    )
    assert.throws(
      () => extractImageGenerationParams({ prompt: 'p', n: '4' }, 'm'),
      InvalidImageBatchCountError
    )
  })

  it('propagates parseImageSize errors', () => {
    assert.throws(
      () => extractImageGenerationParams({ prompt: 'p', size: '999x999' }, 'm'),
      InvalidImageSizeError
    )
  })
})

describe('logImageUnsupportedParams', () => {
  function makeLogger(): {
    warnings: string[]
    logger: Parameters<typeof logImageUnsupportedParams>[1]
  } {
    const warnings: string[] = []
    const logger = { warn: (msg: string) => warnings.push(msg) } as Parameters<
      typeof logImageUnsupportedParams
    >[1]
    return { warnings, logger }
  }

  it('does not warn on empty body', () => {
    const { warnings, logger } = makeLogger()
    logImageUnsupportedParams({}, logger)
    assert.equal(warnings.length, 0)
  })

  it('warns for each advisory image param (no output-shaping ones — those throw)', () => {
    const { warnings, logger } = makeLogger()
    logImageUnsupportedParams(
      {
        quality: 'high',
        style: 'vivid',
        moderation: 'low',
        partial_images: 2,
        user: 'end-user-42',
        input_fidelity: 'high'
      },
      logger
    )
    assert.equal(warnings.length, 6)
    assert.ok(warnings.some((w) => w.includes('quality')))
    assert.ok(warnings.some((w) => w.includes('style')))
    assert.ok(warnings.some((w) => w.includes('moderation')))
    assert.ok(warnings.some((w) => w.includes('partial_images')))
    assert.ok(warnings.some((w) => w.includes('user')))
    assert.ok(warnings.some((w) => w.includes('input_fidelity')))
  })

  it('does not warn on output-shaping params (they are rejected loudly elsewhere)', () => {
    const { warnings, logger } = makeLogger()
    logImageUnsupportedParams(
      {
        output_format: 'jpeg',
        output_compression: 60,
        background: 'transparent'
      },
      logger
    )
    assert.equal(warnings.length, 0)
  })

  it('does not warn on stream (handled by route, not the warning helper)', () => {
    const { warnings, logger } = makeLogger()
    logImageUnsupportedParams({ stream: true }, logger)
    assert.equal(warnings.length, 0)
    logImageUnsupportedParams({ stream: false }, logger)
    assert.equal(warnings.length, 0)
  })

  it('does not warn on n (forwarded as-is by extractImageGenerationParams)', () => {
    const { warnings, logger } = makeLogger()
    logImageUnsupportedParams({ n: 10 }, logger)
    assert.equal(warnings.length, 0)
    logImageUnsupportedParams({ n: 4 }, logger)
    assert.equal(warnings.length, 0)
  })
})

describe('assertSupportedImageOutputParams', () => {
  it('accepts an empty body', () => {
    assert.doesNotThrow(() => assertSupportedImageOutputParams({}))
  })

  it('accepts output_format=png', () => {
    assert.doesNotThrow(() => assertSupportedImageOutputParams({ output_format: 'png' }))
  })

  it('throws unsupported_output_format on jpeg/webp', () => {
    for (const fmt of ['jpeg', 'webp', 'JPG', 'avif']) {
      let err: unknown
      try {
        assertSupportedImageOutputParams({ output_format: fmt })
      } catch (e) {
        err = e
      }
      assert.ok(err instanceof UnsupportedImageOutputError)
      assert.equal((err as UnsupportedImageOutputError).code, 'unsupported_output_format')
    }
  })

  it('throws unsupported_output_compression when output_compression is set', () => {
    let err: unknown
    try {
      assertSupportedImageOutputParams({ output_compression: 80 })
    } catch (e) {
      err = e
    }
    assert.ok(err instanceof UnsupportedImageOutputError)
    assert.equal((err as UnsupportedImageOutputError).code, 'unsupported_output_compression')
  })

  it('throws unsupported_background when background is set', () => {
    for (const bg of ['transparent', 'opaque', 'auto']) {
      let err: unknown
      try {
        assertSupportedImageOutputParams({ background: bg })
      } catch (e) {
        err = e
      }
      assert.ok(err instanceof UnsupportedImageOutputError)
      assert.equal((err as UnsupportedImageOutputError).code, 'unsupported_background')
    }
  })

  it('treats undefined / null as absent', () => {
    assert.doesNotThrow(() =>
      assertSupportedImageOutputParams({
        output_format: undefined,
        output_compression: null,
        background: undefined
      })
    )
  })
})

describe('coerceMultipartFields', () => {
  it('parses integer n and seed from strings', () => {
    const m = new Map<string, string>([
      ['n', '4'],
      ['seed', '42'],
      ['model', 'sd']
    ])
    const o = coerceMultipartFields(m)
    assert.equal(o['n'], 4)
    assert.equal(o['seed'], 42)
    assert.equal(o['model'], 'sd')
  })

  it('parses stream and strength', () => {
    const m = new Map<string, string>([
      ['stream', 'true'],
      ['strength', '0.7']
    ])
    const o = coerceMultipartFields(m)
    assert.equal(o['stream'], true)
    assert.equal(o['strength'], 0.7)
  })
})

describe('extractImageEditParams', () => {
  const buf = new Uint8Array([1, 2, 3])

  it('sets init_image and forwards prompt', () => {
    const body: Record<string, unknown> = { model: 'ignored', prompt: 'x', n: 2 }
    const p = extractImageEditParams(body, buf, 'sdk-1')
    assert.equal(p.modelId, 'sdk-1')
    assert.equal(p.prompt, 'x')
    assert.deepEqual(Array.from(p.init_image!), Array.from(buf))
    assert.equal(p.batch_count, 2)
  })

  it('maps strength when in range', () => {
    const body: Record<string, unknown> = { prompt: 'p', strength: 0.5 }
    const p = extractImageEditParams(body, buf, 'm')
    assert.equal(p.strength, 0.5)
  })

  it('throws InvalidImageStrengthError when strength is out of range', () => {
    assert.throws(
      () => extractImageEditParams({ prompt: 'p', strength: 2 }, buf, 'm'),
      InvalidImageStrengthError
    )
    assert.throws(
      () => extractImageEditParams({ prompt: 'p', strength: -0.1 }, buf, 'm'),
      InvalidImageStrengthError
    )
  })

  it('throws InvalidImageStrengthError when strength is non-numeric', () => {
    assert.throws(
      () => extractImageEditParams({ prompt: 'p', strength: 'half' }, buf, 'm'),
      InvalidImageStrengthError
    )
  })

  it('treats absent strength as no-op', () => {
    const p = extractImageEditParams({ prompt: 'p' }, buf, 'm')
    assert.equal(p.strength, undefined)
  })

  it('propagates InvalidImagePromptError', () => {
    assert.throws(
      () => extractImageEditParams({ prompt: '' } as Record<string, unknown>, buf, 'm'),
      InvalidImagePromptError
    )
  })
})

describe('logImageEditExtraWarnings', () => {
  function makeLogger(): {
    warnings: string[]
    logger: Parameters<typeof logImageEditExtraWarnings>[2]
  } {
    const warnings: string[] = []
    const logger = { warn: (msg: string) => warnings.push(msg) } as Parameters<
      typeof logImageEditExtraWarnings
    >[2]
    return { warnings, logger }
  }

  it('warns on extra images', () => {
    const { warnings, logger } = makeLogger()
    logImageEditExtraWarnings({}, { extraImageCount: 2 }, logger)
    assert.ok(warnings.some((w) => w.includes('3 files')))
  })

  it('does not warn when there is exactly one image', () => {
    const { warnings, logger } = makeLogger()
    logImageEditExtraWarnings({}, { extraImageCount: 0 }, logger)
    assert.equal(warnings.length, 0)
  })
})
