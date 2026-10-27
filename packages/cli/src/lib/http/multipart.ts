import type { ServerOptions } from './index.js'

export type MultipartPart =
  | {
      type: 'file'
      fieldname: string
      filename: string
      mimetype: string
      toBuffer(): Promise<Buffer>
    }
  | { type: 'field'; fieldname: string; value: string }

function malformed(message: string): Error {
  return new Error(message)
}
function delimiterKind(body: Buffer, position: number): 'part' | 'end' | null {
  const suffix = body.subarray(position, position + 2).toString()
  if (suffix === '\r\n') return 'part'
  if (suffix !== '--') return null
  let end = position + 2
  while (body[end] === 32 || body[end] === 9) end++
  return end === body.length || body.subarray(end, end + 2).toString() === '\r\n' ? 'end' : null
}
export async function* multipartParts(
  body: Buffer,
  contentType: string,
  limits: ServerOptions['multipart'] = {}
): AsyncGenerator<MultipartPart> {
  const match = /(?:^|;)\s*boundary=(?:"([^"\r\n]+)"|([^;\s]+))/i.exec(contentType)
  const boundary = match?.[1] ?? match?.[2]
  if (!boundary || boundary.length > 200) throw malformed('Missing or invalid multipart boundary')
  const delimiter = Buffer.from(`--${boundary}`)
  const separator = Buffer.from(`\r\n--${boundary}`)
  let position = 0,
    files = 0,
    fields = 0
  if (!body.subarray(0, delimiter.length).equals(delimiter)) {
    throw malformed('Invalid multipart opening boundary')
  }
  position = delimiter.length
  while (position < body.length) {
    if (delimiterKind(body, position) === 'end') return
    if (body.subarray(position, position + 2).toString() !== '\r\n') {
      throw malformed('Invalid multipart delimiter')
    }
    position += 2
    const headerEnd = body.indexOf('\r\n\r\n', position)
    if (headerEnd < 0 || headerEnd - position > (limits.headerSize ?? 16_384)) {
      throw malformed('Multipart headers too large or incomplete')
    }
    const headers: Record<string, string> = Object.create(null) as Record<string, string>
    for (const line of body.subarray(position, headerEnd).toString('utf8').split('\r\n')) {
      const colon = line.indexOf(':')
      if (colon < 1) throw malformed('Invalid multipart header')
      headers[line.slice(0, colon).trim().toLowerCase()] = line.slice(colon + 1).trim()
    }
    const disposition = headers['content-disposition'] ?? ''
    if (!/^form-data(?:;|$)/i.test(disposition)) throw malformed('Expected form-data disposition')
    const name = /(?:^|;)\s*name="((?:[^"\\]|\\.)*)"/i
      .exec(disposition)?.[1]
      ?.replace(/\\(.)/g, '$1')
    if (name === undefined) throw malformed('Missing multipart field name')
    const filename = /(?:^|;)\s*filename="((?:[^"\\]|\\.)*)"/i
      .exec(disposition)?.[1]
      ?.replace(/\\(.)/g, '$1')
    const start = headerEnd + 4
    let end = body.indexOf(separator, start)
    while (end >= 0 && delimiterKind(body, end + separator.length) === null) {
      end = body.indexOf(separator, end + 1)
    }
    if (end < 0) throw malformed('Incomplete multipart body')
    const value = body.subarray(start, end)
    if (filename !== undefined) {
      if (++files > (limits.files ?? 10)) throw malformed('Too many uploaded files')
      if (value.length > (limits.fileSize ?? 100 * 1024 * 1024)) {
        throw malformed('Uploaded file too large')
      }
      yield {
        type: 'file',
        fieldname: name,
        filename,
        mimetype: headers['content-type'] ?? 'application/octet-stream',
        toBuffer: () => Promise.resolve(value)
      }
    } else {
      if (++fields > (limits.fields ?? 1000)) throw malformed('Too many multipart fields')
      if (value.length > (limits.fieldSize ?? 1024 * 1024)) {
        throw malformed('Multipart field too large')
      }
      yield { type: 'field', fieldname: name, value: value.toString('utf8') }
    }
    position = end + separator.length
  }
  throw malformed('Incomplete multipart closing boundary')
}
