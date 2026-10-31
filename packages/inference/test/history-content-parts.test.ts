import test from 'brittle'
import fs from 'bare-fs'
import os from 'bare-os'
import path from 'bare-path'
import { historyMessageSchema } from '@/schemas'
import { AttachmentNotFoundError } from '@/errors/index'
import { transformMessages } from '@/plugins/builtin/llamacpp-completion/ops/completion-stream'
import { generateCacheKey } from '@/plugins/ops/kv-cache-utils'

// A user turn may interleave text and images as ordered content parts. The
// addon renders each media part as a marker at its position, so one turn keeps
// the text next to the image it refers to — which `attachments` cannot do,
// because every attachment is sent before the text.

function withImages<T>(fn: (images: { a: string; b: string }) => T): T {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qvac-content-parts-'))
  const a = path.join(dir, 'a.jpg')
  const b = path.join(dir, 'b.jpg')
  fs.writeFileSync(a, 'a')
  fs.writeFileSync(b, 'b')
  try {
    return fn({ a, b })
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
}

test('historyMessageSchema: a user turn accepts ordered text and media parts', (t) => {
  const parsed = historyMessageSchema.safeParse({
    role: 'user',
    content: [
      { type: 'text', text: 'Which image shows the same place as ' },
      { type: 'media', path: '/images/place.jpg' },
      { type: 'text', text: '?\nA. ' },
      { type: 'media', path: '/images/a.jpg' }
    ]
  })
  t.ok(parsed.success, 'ordered parts must be accepted on a user turn')
})

test('historyMessageSchema: content parts are user-only', (t) => {
  for (const role of ['assistant', 'system', 'tool']) {
    const parsed = historyMessageSchema.safeParse({
      role,
      content: [{ type: 'text', text: 'x' }]
    })
    t.is(parsed.success, false, `${role} must not accept content parts`)
  }
})

test('historyMessageSchema: parts and attachments cannot be combined', (t) => {
  const parsed = historyMessageSchema.safeParse({
    role: 'user',
    content: [{ type: 'media', path: '/images/a.jpg' }],
    attachments: [{ path: '/images/b.jpg' }]
  })
  t.is(parsed.success, false, 'the position of an attachment would be ambiguous')
})

test('historyMessageSchema: malformed parts are rejected', (t) => {
  const cases = [
    { role: 'user', content: [{ type: 'image', path: '/images/a.jpg' }] },
    { role: 'user', content: [{ type: 'media' }] },
    { role: 'user', content: [{ type: 'media', path: '' }] },
    { role: 'user', content: [{ type: 'text' }] },
    { role: 'user', content: [{ type: 'text', text: 'x', path: '/images/a.jpg' }] },
    { role: 'user', content: ['plain string'] }
  ]
  for (const message of cases) {
    t.is(historyMessageSchema.safeParse(message).success, false, JSON.stringify(message))
  }
})

test('transformMessages: parts stay in one message, in order, as addon parts', (t) => {
  withImages(({ a, b }) => {
    t.alike(
      transformMessages([
        {
          role: 'user',
          content: [
            { type: 'text', text: 'Image A:' },
            { type: 'media', path: a },
            { type: 'text', text: 'Image B:' },
            { type: 'media', path: b },
            { type: 'text', text: 'Compare.' }
          ]
        }
      ]),
      [
        {
          role: 'user',
          content: [
            { type: 'text', text: 'Image A:' },
            { type: 'media', content: a },
            { type: 'text', text: 'Image B:' },
            { type: 'media', content: b },
            { type: 'text', text: 'Compare.' }
          ]
        }
      ],
      'one addon message with media markers at their positions'
    )
  })
})

test('transformMessages: a missing media part path is an AttachmentNotFoundError', (t) => {
  let refusal: unknown
  try {
    transformMessages([
      { role: 'user', content: [{ type: 'media', path: '/definitely/not/here.jpg' }] }
    ])
  } catch (error) {
    refusal = error
  }
  t.ok(refusal instanceof AttachmentNotFoundError, 'the caller gets the typed attachment error')
})

test('generateCacheKey: part order and attachment order produce different keys', (t) => {
  const parts = (first: string, second: string) => [
    {
      role: 'user',
      content: [
        { type: 'text' as const, text: 'A. ' },
        { type: 'media' as const, path: first },
        { type: 'text' as const, text: ' B. ' },
        { type: 'media' as const, path: second }
      ]
    }
  ]
  t.not(generateCacheKey(parts('/a.jpg', '/b.jpg')), generateCacheKey(parts('/b.jpg', '/a.jpg')))
  t.not(
    generateCacheKey(parts('/a.jpg', '/b.jpg')),
    generateCacheKey([{ role: 'user', content: 'A.  B. ' }]),
    'parts must not collide with the text they concatenate to'
  )
})
