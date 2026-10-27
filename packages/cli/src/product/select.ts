type Point = { x: number; y: number }
import { clean, cellWidth } from './text.js'

// Splits plain text at terminal columns, so a wide glyph is never cut in half.
function split(text: string, from: number, to: number) {
  let col = 0,
    before = '',
    mid = '',
    after = ''
  for (const char of text) {
    const w = cellWidth(char)
    if (col + w <= from) {
      before += char
    } else if (col < to) {
      mid += char
    } else {
      after += char
    }

    col += w
  }

  return [before, mid, after] as const
}

export function ordered(a: { y: number; x: number }, b: { y: number; x: number }) {
  return a.y < b.y || (a.y === b.y && a.x <= b.x) ? ([a, b] as const) : ([b, a] as const)
}

function span(y: number, start: Point, end: Point) {
  return [y === start.y ? start.x : 0, y === end.y ? end.x + 1 : Infinity] as const
}

export function selectionText(rows: string[], a: Point, b: Point) {
  const [start, end] = ordered(a, b),
    out = []
  for (let y = start.y; y <= end.y && y < rows.length; y++) {
    out.push(split(clean(rows[y]), ...span(y, start, end))[1].trimEnd())
  }

  return out.join('\n').trim()
}

export function paintSelection(rows: string[], a: Point, b: Point) {
  const [start, end] = ordered(a, b)
  return rows.map((row, y: number) => {
    if (y < start.y || y > end.y) return row
    const [before, mid, after] = split(clean(row), ...span(y, start, end))
    return `${before}\x1b[7m${mid}\x1b[27m${after}\x1b[K`
  })
}
