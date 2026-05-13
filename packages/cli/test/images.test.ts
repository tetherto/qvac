import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  parseImageSize,
  extractImageGenerationParams,
  logImageUnsupportedParams,
  encodeImageDataUrl,
  InvalidImagePromptError,
  InvalidImageSizeError,
  InvalidImageBatchCountError
} from '../src/serve/adapters/openai/translate.js'

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
    assert.throws(() => extractImageGenerationParams({ prompt: 'p', n: 0 }, 'm'), InvalidImageBatchCountError)
    assert.throws(() => extractImageGenerationParams({ prompt: 'p', n: -3 }, 'm'), InvalidImageBatchCountError)
    assert.throws(() => extractImageGenerationParams({ prompt: 'p', n: 1.5 }, 'm'), InvalidImageBatchCountError)
    assert.throws(() => extractImageGenerationParams({ prompt: 'p', n: '4' }, 'm'), InvalidImageBatchCountError)
  })

  it('propagates parseImageSize errors', () => {
    assert.throws(
      () => extractImageGenerationParams({ prompt: 'p', size: '999x999' }, 'm'),
      InvalidImageSizeError
    )
  })
})

describe('logImageUnsupportedParams', () => {
  function makeLogger (): { warnings: string[]; logger: Parameters<typeof logImageUnsupportedParams>[1] } {
    const warnings: string[] = []
    const logger = { warn: (msg: string) => warnings.push(msg) } as Parameters<typeof logImageUnsupportedParams>[1]
    return { warnings, logger }
  }

  it('does not warn on empty body', () => {
    const { warnings, logger } = makeLogger()
    logImageUnsupportedParams({}, logger)
    assert.equal(warnings.length, 0)
  })

  it('warns for each unsupported image param', () => {
    const { warnings, logger } = makeLogger()
    logImageUnsupportedParams({
      quality: 'high',
      style: 'vivid',
      background: 'transparent',
      moderation: 'low',
      output_compression: 60,
      partial_images: 2,
      user: 'end-user-42'
    }, logger)
    assert.equal(warnings.length, 7)
    assert.ok(warnings.some(w => w.includes('quality')))
    assert.ok(warnings.some(w => w.includes('style')))
    assert.ok(warnings.some(w => w.includes('background')))
    assert.ok(warnings.some(w => w.includes('moderation')))
    assert.ok(warnings.some(w => w.includes('output_compression')))
    assert.ok(warnings.some(w => w.includes('partial_images')))
    assert.ok(warnings.some(w => w.includes('user')))
  })

  it('warns when output_format is not png', () => {
    const { warnings, logger } = makeLogger()
    logImageUnsupportedParams({ output_format: 'jpeg' }, logger)
    assert.equal(warnings.length, 1)
    assert.ok(warnings[0]!.includes('output_format=jpeg'))
    assert.ok(warnings[0]!.includes('PNG'))
  })

  it('does not warn when output_format is png', () => {
    const { warnings, logger } = makeLogger()
    logImageUnsupportedParams({ output_format: 'png' }, logger)
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

describe('encodeImageDataUrl', () => {
  it('encodes raw bytes as a base64 data URL with the default png mime', () => {
    const url = encodeImageDataUrl(new Uint8Array([0xff, 0xd8, 0xff]))
    assert.ok(url.startsWith('data:image/png;base64,'))
    const base64 = url.slice('data:image/png;base64,'.length)
    assert.deepEqual(Array.from(Buffer.from(base64, 'base64')), [0xff, 0xd8, 0xff])
  })

  it('honors a custom mime type', () => {
    const url = encodeImageDataUrl(new Uint8Array([1, 2, 3]), 'image/webp')
    assert.ok(url.startsWith('data:image/webp;base64,'))
  })

  it('produces a valid base64 payload', () => {
    const url = encodeImageDataUrl(new Uint8Array([0, 0, 0, 0]))
    const base64 = url.split(',')[1]!
    assert.match(base64, /^[A-Za-z0-9+/]+={0,2}$/)
  })
})
