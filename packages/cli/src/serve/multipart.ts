import type { IncomingMessage } from 'node:http'

export interface MultipartFile {
  fieldName: string
  fileName: string
  contentType: string
  data: Buffer
}

export interface MultipartResult {
  fields: Map<string, string>
  file: MultipartFile | null
}

const MAX_MULTIPART_SIZE = 25 * 1024 * 1024

export function readMultipart (req: IncomingMessage): Promise<MultipartResult> {
  return new Promise((resolve, reject) => {
    const contentType = req.headers['content-type'] ?? ''
    const match = contentType.match(/boundary=(?:"([^"]+)"|([^\s;]+))/)
    if (!match) {
      reject(new Error('Missing multipart boundary in Content-Type header.'))
      return
    }
    const boundary = match[1] ?? match[2]!

    const chunks: Buffer[] = []
    let totalSize = 0

    req.on('data', (chunk: Buffer) => {
      totalSize += chunk.length
      if (totalSize > MAX_MULTIPART_SIZE) {
        reject(new Error(`Request body exceeds ${MAX_MULTIPART_SIZE / (1024 * 1024)}MB limit.`))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })

    req.on('end', () => {
      try {
        resolve(parseMultipartBody(Buffer.concat(chunks), boundary))
      } catch (err) {
        reject(err)
      }
    })

    req.on('error', reject)
  })
}

function parseMultipartBody (body: Buffer, boundary: string): MultipartResult {
  const fields = new Map<string, string>()
  let file: MultipartFile | null = null

  const delimiter = Buffer.from(`--${boundary}`)
  const closeDelimiter = Buffer.from(`--${boundary}--`)

  let start = indexOf(body, delimiter, 0)
  if (start === -1) return { fields, file }
  start += delimiter.length

  while (start < body.length) {
    if (indexOf(body, closeDelimiter, start - delimiter.length) === start - delimiter.length) break

    if (body[start] === 0x0d && body[start + 1] === 0x0a) start += 2

    const headerEnd = indexOf(body, Buffer.from('\r\n\r\n'), start)
    if (headerEnd === -1) break

    const headerBlock = body.subarray(start, headerEnd).toString('utf8')
    const dataStart = headerEnd + 4

    let nextBoundary = indexOf(body, delimiter, dataStart)
    if (nextBoundary === -1) nextBoundary = body.length

    let dataEnd = nextBoundary - 2
    if (dataEnd < dataStart) dataEnd = dataStart

    const partData = body.subarray(dataStart, dataEnd)

    const nameMatch = headerBlock.match(/name="([^"]*)"/)
    const filenameMatch = headerBlock.match(/filename="([^"]*)"/)
    const ctMatch = headerBlock.match(/Content-Type:\s*(\S+)/i)

    if (filenameMatch && nameMatch) {
      file = {
        fieldName: nameMatch[1]!,
        fileName: filenameMatch[1]!,
        contentType: ctMatch?.[1] ?? 'application/octet-stream',
        data: Buffer.from(partData)
      }
    } else if (nameMatch) {
      fields.set(nameMatch[1]!, partData.toString('utf8'))
    }

    start = nextBoundary + delimiter.length
  }

  return { fields, file }
}

function indexOf (buf: Buffer, needle: Buffer, from: number): number {
  for (let i = from; i <= buf.length - needle.length; i++) {
    let found = true
    for (let j = 0; j < needle.length; j++) {
      if (buf[i + j] !== needle[j]) {
        found = false
        break
      }
    }
    if (found) return i
  }
  return -1
}
