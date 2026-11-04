import { z } from 'zod'

// Multipart sends every text part as a string. These accept the string form
// alongside the JSON one; anything else is left for the inner schema to reject.

export function formBoolean() {
  return z.preprocess(
    (value) => (value === 'true' ? true : value === 'false' ? false : value),
    z.boolean()
  )
}

export function formNumber<T extends z.ZodType>(schema: T) {
  return z.preprocess((value) => {
    if (typeof value !== 'string' || value.trim() === '') return value
    const number = Number(value)
    return Number.isNaN(number) ? value : number
  }, schema)
}

/** A structured field, sent as JSON text in a multipart body. */
export function formJson<T extends z.ZodType>(schema: T) {
  return z.preprocess((value) => {
    if (typeof value !== 'string') return value
    try {
      return JSON.parse(value) as unknown
    } catch {
      return value
    }
  }, schema)
}
