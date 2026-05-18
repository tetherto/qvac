import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import type { IncomingMessage } from 'node:http'
import { readMultipart } from '../src/serve/multipart.js'

function makeMultipartReq (body: Buffer, boundary: string): IncomingMessage {
  const req = new EventEmitter() as IncomingMessage
  req.headers = { 'content-type': `multipart/form-data; boundary=${boundary}` }
  req.method = 'POST'
  queueMicrotask(() => {
    req.emit('data', body)
    req.emit('end')
  })
  return req
}

describe('readMultipart files[]', () => {
  it('collects every file part and keeps file as the first', async () => {
    const boundary = 'abc'
    const body = Buffer.from(
      `--${boundary}\r\n` +
      'Content-Disposition: form-data; name="model"\r\n' +
      '\r\n' +
      'm1\r\n' +
      `--${boundary}\r\n` +
      'Content-Disposition: form-data; name="image"; filename="a.png"\r\n' +
      'Content-Type: image/png\r\n' +
      '\r\n' +
      'AAA\r\n' +
      `--${boundary}\r\n` +
      'Content-Disposition: form-data; name="image"; filename="b.png"\r\n' +
      'Content-Type: image/png\r\n' +
      '\r\n' +
      'BBB\r\n' +
      `--${boundary}--\r\n`
    )

    const result = await readMultipart(makeMultipartReq(body, boundary))
    assert.equal(result.files.length, 2)
    assert.equal(result.file?.data.toString(), 'AAA')
    assert.equal(result.files[0]!.data.toString(), 'AAA')
    assert.equal(result.files[1]!.data.toString(), 'BBB')
    assert.equal(result.fields.get('model'), 'm1')
  })
})
