// For the pty tests: reads the escapes bare-tui and the app send as a terminal would, drops the rest.
import { cellWidth } from '../../../dist/product/text.js'

const FULL_REPAINT = '\x1b[H' // bare-tui starts every full repaint at home with no row given

export class Screen {
  constructor(rows, cols) {
    this.rows = rows
    this.cols = cols
    this.grid = blank(rows, cols)
    this.row = 0
    this.col = 0
    this.wrapping = false // past the last column: the next glyph wraps first
    this.scrolls = 0
    this.repaints = 0
    this.resizedAt = 0
    this.rest = ''
    this.sinceRepaint = ''
  }

  // Terminals reflow wide rows on resize, which lands a stale status mid-row until a full repaint.
  resize(rows, cols) {
    const lines = this.grid.flatMap((row) => {
      const cells = row.slice(0, row.findLastIndex((cell) => cell !== ' ') + 1)
      const parts = [cells.slice(0, cols)]
      for (let at = cols; at < cells.length; at += cols) {
        parts.push(cells.slice(at, at + cols))
      }

      return parts
    })
    const grid = blank(rows, cols)
    lines.slice(0, rows).forEach((cells, r) => cells.forEach((cell, c) => (grid[r][c] = cell)))

    this.grid = grid
    this.resizedAt = this.repaints
    this.rows = rows
    this.cols = cols
    this.row = Math.min(this.row, rows - 1)
    this.col = Math.min(this.col, cols - 1)
    this.wrapping = false
  }

  write(data) {
    let text = this.rest + data
    this.rest = ''
    const cut = text.lastIndexOf('\x1b')
    if (cut !== -1 && !complete(text.slice(cut))) {
      this.rest = text.slice(cut)
      text = text.slice(0, cut)
    }

    const at = text.lastIndexOf(FULL_REPAINT)
    this.sinceRepaint = at === -1 ? this.sinceRepaint + text : text.slice(at)
    this.repaints += text.split(FULL_REPAINT).length - 1
    this.feed(text)
  }

  get repaintedSinceResize() {
    return this.repaints > this.resizedAt
  }

  // What a terminal that saw only the last full repaint would show: any difference is a stale row.
  repainted() {
    const clean = new Screen(this.rows, this.cols)
    clean.feed(this.sinceRepaint)

    return clean.text()
  }

  text() {
    return this.grid.map((row) => row.join('').trimEnd()).join('\n')
  }

  feed(text) {
    for (let i = 0; i < text.length;) {
      const char = text[i]
      if (char === '\x1b') {
        i += this.escape(text.slice(i))
        continue
      }

      if (char === '\r') {
        this.col = 0
        this.wrapping = false
      } else if (char === '\n') {
        this.down()
      } else if (char === '\b') {
        this.col = Math.max(0, this.col - 1)
      } else if (char >= ' ') {
        const glyph = String.fromCodePoint(text.codePointAt(i))
        this.put(glyph)
        i += glyph.length
        continue
      }

      i++
    }
  }

  escape(text) {
    const csi = /^\x1b\[([?>]?)([\d;]*)([ -/]*)([@-~])/.exec(text)
    if (csi && !csi[1]) {
      this.control(csi[3] + csi[4], csi[2] ? csi[2].split(';').map(Number) : [])
    }

    if (csi) {
      return csi[0].length
    }

    const osc = /^\x1b\][^\x07\x1b]*(\x07|\x1b\\)/.exec(text)
    if (osc) {
      return osc[0].length
    }

    return Math.min(2, text.length)
  }

  control(code, [a, b]) {
    this.wrapping = false
    if (code === 'H' || code === 'f') {
      this.row = clamp((a || 1) - 1, this.rows)
      this.col = clamp((b || 1) - 1, this.cols)
    } else if (code === 'K') {
      const [from, to] = ERASE[a]?.(this) ?? [this.col, this.cols]
      for (let c = from; c < to; c++) {
        this.grid[this.row][c] = ' '
      }
    } else if (code === 'J') {
      if (a === 2) {
        this.grid = blank(this.rows, this.cols)
        return
      }

      this.control('K', [0])
      for (let r = this.row + 1; r < this.rows; r++) {
        this.grid[r] = Array(this.cols).fill(' ')
      }
    } else if (code === 'A') {
      this.row = Math.max(0, this.row - (a || 1))
    } else if (code === 'B') {
      this.row = clamp(this.row + (a || 1), this.rows)
    } else if (code === 'C') {
      this.col = clamp(this.col + (a || 1), this.cols)
    } else if (code === 'D') {
      this.col = Math.max(0, this.col - (a || 1))
    }
  }

  put(glyph) {
    const width = cellWidth(glyph)
    if (width === 0) {
      return
    }

    if (this.wrapping || this.col + width > this.cols) {
      this.col = 0
      this.down()
    }

    this.grid[this.row][this.col] = glyph
    if (width === 2 && this.col + 1 < this.cols) {
      this.grid[this.row][this.col + 1] = ''
    }

    this.col += width
    if (this.col >= this.cols) {
      this.col = this.cols - 1
      this.wrapping = true
    }
  }

  down() {
    this.wrapping = false
    if (this.row < this.rows - 1) {
      this.row++
      return
    }

    this.grid.shift()
    this.grid.push(Array(this.cols).fill(' '))
    this.scrolls++
  }
}

// erase in line: 1 is to the cursor, 2 the whole row, anything else from the cursor on
const ERASE = { 1: (s) => [0, s.col + 1], 2: (s) => [0, s.cols] }
const blank = (rows, cols) => Array.from({ length: rows }, () => Array(cols).fill(' '))
const clamp = (n, size) => Math.min(Math.max(n, 0), size - 1)
const complete = (escape) =>
  /^\x1b\[[?>]?[\d;]*[ -/]*[@-~]/.test(escape) ||
  /^\x1b\][^\x07\x1b]*(\x07|\x1b\\)/.test(escape) ||
  /^\x1b[^[\]]/.test(escape)
