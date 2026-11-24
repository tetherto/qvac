import { z } from 'zod'

const EQUALS = 0x3d

// 1 for each character of the standard base64 alphabet (RFC 4648 section 4).
const ALPHABET = new Uint8Array(128)
for (const range of ['AZ', 'az', '09', '++', '//']) {
  for (let c = range.charCodeAt(0); c <= range.charCodeAt(1); c++) ALPHABET[c] = 1
}

/**
 * Whether `value` is padded standard base64, checked in one pass.
 *
 * Zod's `.base64()` and patterns such as `^(?:[A-Za-z0-9+/]{4})*...$` repeat a
 * group once per four characters, which engines give up on a few million
 * characters in, each in its own way: V8 throws `RangeError: Maximum call
 * stack size exceeded`, and JavaScriptCore returns false. Images and tensors
 * reach that size as base64 (one 512x512 VLA camera is 4,194,304 characters),
 * and these schemas run on the client (Hermes, V8 or JavaScriptCore) as well
 * as in the worker, so binary fields are checked here instead.
 */
export function isBase64(value: string): boolean {
  const length = value.length
  if (length % 4 !== 0) return false

  let end = length
  if (end > 0 && value.charCodeAt(end - 1) === EQUALS) end--
  if (end > 0 && value.charCodeAt(end - 1) === EQUALS) end--

  for (let i = 0; i < end; i++) {
    const c = value.charCodeAt(i)
    if (c >= 128 || ALPHABET[c] === 0) return false
  }
  return true
}

/**
 * A string of padded standard base64, of any length the transport carries.
 * Use it for every field that carries bytes as base64.
 */
export function base64String() {
  return z
    .string()
    .refine(isBase64, { message: 'Invalid base64-encoded string' })
    .meta({ contentEncoding: 'base64' })
}
