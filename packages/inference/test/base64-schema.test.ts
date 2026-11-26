import test from 'brittle'
import fs from 'bare-fs'
import path from 'bare-path'
import URL from 'bare-url'
import { base64String, isBase64 } from '@/schemas/base64'
import {
  vlaRunRequestSchema,
  imageEmbeddingInputSchema,
  upscaleRequestSchema,
  estimateDisparityRequestSchema
} from '@/schemas'
import { encodeBase64 } from '@/utils/encoding'

// The pattern the schemas used before: one starred group per four characters.
const QUAD_PATTERN = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/

// One 512x512 VLA camera: 3 * 512 * 512 float32 values.
const VLA_CAMERA_CHARS = ((3 * 512 * 512 * 4) / 3) * 4

test('isBase64: accepts padded base64 of every length remainder', (t) => {
  for (let n = 0; n <= 12; n++) {
    const bytes = new Uint8Array(n).map((_, i) => (i * 37 + 11) % 256)
    t.ok(isBase64(encodeBase64(bytes)), `${n} bytes`)
  }
  t.ok(isBase64(''))
  t.ok(isBase64('+/+/'))
})

test('isBase64: rejects malformed input', (t) => {
  for (const value of [
    'A',
    'AA',
    'AAA',
    'AA=',
    'A===',
    '====',
    'AA=A',
    'AA==AAAA',
    'AAA*',
    'AAA-',
    'AAA_',
    'AA A',
    'AAAA\n',
    'AAAé',
    'AAAĀ'
  ]) {
    t.absent(isBase64(value), JSON.stringify(value))
  }
})

test('isBase64: agrees with the previous pattern on short strings', (t) => {
  const characters = 'Az09+/=*'
  let checked = 0
  for (let length = 0; length <= 6; length++) {
    const total = characters.length ** length
    for (let index = 0; index < total; index++) {
      let value = ''
      for (let k = 0, rest = index; k < length; k++, rest = Math.floor(rest / characters.length)) {
        value += characters[rest % characters.length]
      }
      if (isBase64(value) !== QUAD_PATTERN.test(value)) {
        t.fail(`disagrees on ${JSON.stringify(value)}`)
        return
      }
      checked++
    }
  }
  t.pass(`${checked} strings agree`)
})

test('isBase64: checks multi-megabyte strings without throwing', (t) => {
  // The previous pattern throws RangeError on V8 from about 4.8M characters
  // and returns false on JavaScriptCore from about 6M.
  const valid = 'A'.repeat(24_000_000)
  t.ok(isBase64(valid))
  t.absent(isBase64(valid.slice(0, -1) + '*'))
  t.absent(isBase64(valid.slice(0, -4) + 'A==='))
})

test('base64String: reports malformed input as a validation issue', (t) => {
  const result = base64String().safeParse('not base64!')
  t.is(result.success, false)
  t.is(result.error?.issues[0]?.message, 'Invalid base64-encoded string')
})

test('vlaRunRequestSchema: accepts two full-size camera images', (t) => {
  const image = 'A'.repeat(VLA_CAMERA_CHARS)
  const result = vlaRunRequestSchema.safeParse({
    type: 'vlaRun',
    modelId: 'vla',
    images: [image, image],
    imgWidth: 512,
    imgHeight: 512,
    state: '',
    tokens: 'AAAA',
    mask: 'AA=='
  })
  t.is(result.success, true)
})

test('binary request fields accept payloads past the previous pattern limit', (t) => {
  const large = 'A'.repeat(8_000_000)
  t.is(imageEmbeddingInputSchema.safeParse({ image: large }).success, true, 'image embedding')
  t.is(upscaleRequestSchema.safeParse({ modelId: 'm', image: large }).success, true, 'upscale')
  t.is(
    estimateDisparityRequestSchema.safeParse({
      type: 'estimateDisparity',
      modelId: 'm',
      left: large,
      right: large
    }).success,
    true,
    'stereo depth'
  )
})

test('schemas do not use the per-quad base64 pattern or Zod .base64()', (t) => {
  // Compiled sources sit at test/dist/src beside this file's test/dist/test.
  const root = URL.fileURLToPath(new URL('../src/', import.meta.url))
  // The helper's own comment names Zod's `.base64()`.
  const helper = path.join(root, 'schemas', 'base64.js')
  const offenders: string[] = []
  const visit = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true }) as unknown as Array<{
      name: string
      isDirectory(): boolean
    }>) {
      const file = path.join(dir, entry.name)
      if (entry.isDirectory()) visit(file)
      else if (entry.name.endsWith('.js') && file !== helper) {
        const source = fs.readFileSync(file, 'utf8') as unknown as string
        if (/\.base64\(\)|z\.base64\(|9\+\/\]\{4\}\)\*/.test(source)) offenders.push(file)
      }
    }
  }
  visit(root)
  t.alike(offenders, [], 'use base64String() from @/schemas/base64')
})
