import { paint, palette } from './theme.js'
import { wrap, cellWidth } from '../lib/terminal/text.js'

export { strong } from './theme.js'

export const paragraph = (text: string, width: number, color: keyof typeof palette = 'text') =>
  wrap(text, width).map((row) => paint(row, color))

// Footer key hints, `key label` pairs; drops trailing pairs that would overflow width.
export function keyHints(pairs: readonly (readonly string[])[], width = Infinity) {
  let out = '',
    used = 0
  for (const [key, label] of pairs) {
    const size = cellWidth(`${key} ${label}`) + (out ? 3 : 0)
    if (used + size > width) {
      break
    }

    out += (out ? '   ' : '') + paint(key, 'teal') + ' ' + paint(label, 'muted')
    used += size
  }

  return out
}
