import fs from 'bare-fs'
import Buffer from 'bare-buffer'

const GGUF_MAGIC = 0x46554747

const STRING_TYPE = 8
const ARRAY_TYPE = 9

const FIXED_SIZES: Record<number, number> = {
  0: 1,
  1: 1,
  2: 2,
  3: 2,
  4: 4,
  5: 4,
  6: 4,
  7: 1,
  10: 8,
  11: 8,
  12: 8
}

// GGUF writers put `general.architecture` first, ahead of the tokenizer arrays
// that make a header large, so a key past this point is not worth the read.
export const ARCHITECTURE_SCAN_BYTES = 1024 * 1024

/**
 * Walks the header in the first `end` bytes of `buffer` to
 * `general.architecture`. Undefined when the header is not GGUF, holds a value
 * type it cannot skip, or does not reach the key within those bytes.
 */
function scanForArchitecture(buffer: Buffer, end: number): string | undefined {
  let offset = 0
  let bigEndian = false

  const fits = (bytes: number) => offset + bytes <= end

  function u32(): number | undefined {
    if (!fits(4)) return undefined
    const value = bigEndian ? buffer.readUInt32BE(offset) : buffer.readUInt32LE(offset)
    offset += 4
    return value
  }

  function u64(): number | undefined {
    if (!fits(8)) return undefined
    const value = bigEndian ? buffer.readBigUInt64BE(offset) : buffer.readBigUInt64LE(offset)
    offset += 8
    return Number(value)
  }

  function skip(bytes: number): boolean {
    if (!fits(bytes)) return false
    offset += bytes
    return true
  }

  function string(): string | undefined {
    const length = u64()
    if (length === undefined || !fits(length)) return undefined
    const value = buffer.toString('utf8', offset, offset + length)
    offset += length
    return value
  }

  function skipString(): boolean {
    const length = u64()
    return length !== undefined && skip(length)
  }

  function skipValue(type: number): boolean {
    const size = FIXED_SIZES[type]
    if (size !== undefined) return skip(size)
    if (type === STRING_TYPE) return skipString()
    if (type !== ARRAY_TYPE) return false
    const elementType = u32()
    const count = u64()
    if (elementType === undefined || count === undefined) return false
    const elementSize = FIXED_SIZES[elementType]
    if (elementSize !== undefined) return skip(count * elementSize)
    if (elementType !== STRING_TYPE) return false
    for (let i = 0; i < count; i++) {
      if (!skipString()) return false
    }
    return true
  }

  if (u32() !== GGUF_MAGIC) return undefined

  // The magic is the same bytes in both byte orders. A big-endian header is
  // told apart by its version, whose low 16 bits read 0 as little-endian.
  let version = u32()
  if (version === undefined) return undefined
  if ((version & 0xffff) === 0) {
    bigEndian = true
    version = buffer.readUInt32BE(4)
  }
  if (version !== 2 && version !== 3) return undefined

  if (!skip(8)) return undefined
  const kvCount = u64()
  if (kvCount === undefined) return undefined

  for (let i = 0; i < kvCount; i++) {
    const key = string()
    const type = u32()
    if (key === undefined || type === undefined) return undefined
    if (key === 'general.architecture' && type === STRING_TYPE) return string()
    if (!skipValue(type)) return undefined
  }
  return undefined
}

/**
 * The `general.architecture` value from a GGUF header, read from at most the
 * first `ARCHITECTURE_SCAN_BYTES` of the file. Undefined when the file is
 * unreadable, is not GGUF, or does not name an architecture in that range.
 */
export async function readGgufArchitecture(filePath: string): Promise<string | undefined> {
  let fd: number | undefined
  try {
    fd = await fs.open(filePath, 'r')
    const buffer = Buffer.alloc(ARCHITECTURE_SCAN_BYTES)
    let length = 0
    while (length < buffer.length) {
      const read = await fs.read(fd, buffer, length, buffer.length - length, length)
      if (read === 0) break
      length += read
    }
    return scanForArchitecture(buffer, length)
  } catch {
    return undefined
  } finally {
    if (fd !== undefined) await fs.close(fd).catch(() => {})
  }
}
