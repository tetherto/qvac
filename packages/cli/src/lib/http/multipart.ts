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

const FILE_SIZE = 100 * 1024 * 1024
const FILES = 10

// The whole body is buffered before parsing, so it must hold every allowed file, plus framing.
export function multipartBodyLimit(limits: ServerOptions['multipart'] = {}): number {
  return (limits.files ?? FILES) * (limits.fileSize ?? FILE_SIZE) + 1024 * 1024
}
function malformed(message: string): Error {
  return new Error(message)
}
// What follows a boundary: `--` for the last one, then optional linear whitespace and CRLF.
function delimiterEnd(body: Buffer, position: number): { last: boolean; next: number } | null {
  const last = body[position] === 45 && body[position + 1] === 45
  let end = last ? position + 2 : position
  while (body[end] === 32 || body[end] === 9) end++
  if (body[end] === 13 && body[end + 1] === 10) return { last, next: end + 2 }
  return last && end === body.length ? { last, next: end } : null
}
function dispositionParams(disposition: string): Record<string, string> {
  const params: Record<string, string> = Object.create(null) as Record<string, string>
  for (const [, key, quoted, token] of disposition.matchAll(
    /;\s*([^\s=;]+)\s*=\s*(?:"((?:[^"\\]|\\.)*)"|([^;\s]*))/g
  )) {
    params[key!.toLowerCase()] = quoted?.replace(/\\(.)/g, '$1') ?? token!
  }
  return params
}
// RFC 5987 `filename*=UTF-8''percent-encoded`.
function extendedValue(value: string): string {
  const match = /^utf-8'[^']*'(.*)$/i.exec(value)
  if (!match) throw malformed('Unsupported multipart filename encoding')
  try {
    return decodeURIComponent(match[1]!)
  } catch {
    throw malformed('Malformed multipart filename encoding')
  }
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
    const after = delimiterEnd(body, position)
    if (!after) throw malformed('Invalid multipart delimiter')
    if (after.last) return
    position = after.next
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
    const params = dispositionParams(disposition)
    const name = params['name']
    if (name === undefined) throw malformed('Missing multipart field name')
    const extended = params['filename*']
    const filename = extended === undefined ? params['filename'] : extendedValue(extended)
    const start = headerEnd + 4
    let end = body.indexOf(separator, start)
    while (end >= 0 && !delimiterEnd(body, end + separator.length)) {
      end = body.indexOf(separator, end + 1)
    }
    if (end < 0) throw malformed('Incomplete multipart body')
    const value = body.subarray(start, end)
    if (filename !== undefined) {
      if (++files > (limits.files ?? FILES)) throw malformed('Too many uploaded files')
      if (value.length > (limits.fileSize ?? FILE_SIZE)) {
        throw malformed('Uploaded file too large')
      }
      yield {
        type: 'file',
        fieldname: name,
        filename,
        mimetype: headers['content-type'] ?? 'application/octet-stream',
        toBuffer: () => Promise.resolve(Buffer.from(value))
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
