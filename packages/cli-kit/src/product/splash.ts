import type { canvas } from './theme.js'
import { SIZES } from './splash-art.js'
import { paint, strong, logo } from './theme.js'

const TAGLINE = 'Your most powerful device. Everywhere.'

// The widest duck cut that fits, so a short window still gets one; rows carry their own colour.
export function ducks(width: number, height: number) {
  return SIZES.find((size) => size.width <= width && size.rows.length <= height) || null
}

export function bootLines(
  f: ReturnType<typeof canvas>,
  { height, status }: { height: number; status: string }
) {
  const text = [
    '',
    ...logo.map((line) => f.center(paint(line, 'teal'))),
    '',
    f.center(strong(TAGLINE)),
    '',
    f.center(status)
  ]
  const art = ducks(f.inner, height - text.length - 2)
  const rows = art ? art.rows.map((row) => f.center(row)) : []
  const top = Math.max(0, Math.floor((height - rows.length - text.length) / 2))

  return [...Array(top).fill(''), ...rows, ...text]
}
