export interface KeyMessage {
  is(...names: string[]): boolean
  sequence?: string
  name?: string
  ctrl?: boolean
  meta?: boolean
}
import { clean, cellWidth, fit } from './text.js'

const MARKER = /\[paste #\d+ (?:\+\d+ lines|\d+ chars)\]/g
const WORD = /[\p{L}\p{N}_]/u
const UNDO_LIMIT = 200
const RING_LIMIT = 60

function sanitize(value: unknown) {
  return String(value)
    .replace(/\r\n?/g, '\n')
    .replace(/\t/g, '  ')
    .split('\n')
    .map(clean)
    .join('\n')
}

// Separate instances for the draft and command search keep navigation lossless.
export class Editor {
  value = ''
  cursor = 0
  history: string[] = []
  historyIndex: number | null = null
  savedDraft = ''
  limit = 65536
  killRing: string[] = []
  pastes = new Map<string, string>()
  #undo: { value: string; cursor: number }[] = []
  #last: string | null = null
  #pending: 'jump' | null = null
  #yank: { start: number; end: number; index: number } | null = null
  #pasteCount = 0

  set(value: unknown) {
    this.#record()
    this.#replace(String(value))
  }

  insert(text: string) {
    this.#record()
    this.#put(sanitize(text))
    this.#last = null
  }

  reset() {
    this.#replace('')
    this.historyIndex = null
    this.pastes.clear()
    this.#pasteCount = 0
    this.#undo = []
    this.#last = null
    this.#pending = null
  }

  remember() {
    const text = this.expanded()
    if (text && this.history.at(-1) !== text) {
      this.history.push(text)
    }

    this.history = this.history.slice(-100)
    this.reset()
  }

  recall(direction: number) {
    if (!this.history.length) return
    if (this.historyIndex === null) {
      this.savedDraft = this.value
      this.historyIndex = this.history.length
    }

    this.historyIndex = Math.max(0, Math.min(this.history.length, this.historyIndex + direction))
    this.#replace(this.history[this.historyIndex] ?? this.savedDraft)
  }

  paste(text: string) {
    const safe = sanitize(text)
    const lines = safe.split('\n').length
    if (lines <= 10 && safe.length <= 1000) {
      return this.insert(safe)
    }

    const original = safe.slice(0, this.limit)
    const marker =
      lines > 1
        ? `[paste #${this.#pasteCount + 1} +${lines} lines]`
        : `[paste #${this.#pasteCount + 1} ${original.length} chars]`
    if (marker.length > this.limit - this.value.length) {
      return
    }

    this.#record()
    this.#pasteCount++
    this.pastes.set(marker, original)
    this.#put(marker)
    this.#last = null
  }

  expanded() {
    return this.value.replace(MARKER, (marker) => this.pastes.get(marker) ?? marker)
  }

  undo() {
    const state = this.#undo.pop()
    if (!state) {
      return false
    }

    this.value = state.value
    this.cursor = state.cursor
    this.#last = null

    return true
  }

  key(msg: KeyMessage): boolean {
    const last = this.#last
    this.#last = null
    if (this.#pending === 'jump') {
      return this.#jump(msg)
    }

    if (msg.is('alt+y')) {
      return this.#yankPop(last)
    }

    this.#yank = null

    return this.#move(msg) || this.#edit(msg, last)
  }

  #move(msg: KeyMessage): boolean {
    if (msg.is('left', 'ctrl+b')) {
      this.cursor = this.#prev(this.cursor)
    } else if (msg.is('right', 'ctrl+f')) {
      this.cursor = this.#next(this.cursor)
    } else if (msg.is('alt+left', 'ctrl+left', 'alt+b')) {
      this.cursor = this.#wordBack(this.cursor)
    } else if (msg.is('alt+right', 'ctrl+right', 'alt+f')) {
      this.cursor = this.#wordForward(this.cursor)
    } else if (msg.is('home', 'ctrl+a')) {
      this.cursor = this.#lineStart(this.cursor)
    } else if (msg.is('end', 'ctrl+e')) {
      this.cursor = this.#lineEnd(this.cursor)
    } else {
      return false
    }

    return true
  }

  #edit(msg: KeyMessage, last: string | null): boolean {
    const seq = msg.sequence
    if (msg.is('ctrl+]') || (seq === '\x1d' && !msg.meta)) {
      this.#pending = 'jump'
    } else if (msg.is('ctrl+-', 'ctrl+_', 'ctrl+z') || msg.name === 'undo' || seq === '\x1f') {
      this.undo()
    } else if (msg.is('backspace')) {
      this.#delete(this.#prev(this.cursor), this.cursor)
    } else if (msg.is('delete', 'ctrl+d')) {
      this.#delete(this.cursor, this.#next(this.cursor))
    } else if (msg.is('ctrl+w', 'alt+backspace')) {
      this.#killBack(this.#wordBack(this.cursor), last)
    } else if (msg.is('alt+d', 'alt+delete')) {
      this.#killForward(this.#wordForward(this.cursor), last)
    } else if (msg.is('ctrl+u')) {
      const start = this.#lineStart(this.cursor)
      this.#killBack(start < this.cursor ? start : this.#prev(this.cursor), last)
    } else if (msg.is('ctrl+k')) {
      const end = this.#lineEnd(this.cursor)
      this.#killForward(end > this.cursor ? end : this.#next(this.cursor), last)
    } else if (msg.is('ctrl+y')) {
      this.#yankLatest()
    } else if (msg.is('up', 'down')) {
      return this.#vertical(msg.is('up') ? -1 : 1)
    } else if (msg.is('tab')) {
      this.insert('  ')
    } else if (!msg.ctrl && !msg.meta && typeof seq === 'string' && seq >= ' ') {
      this.#type(seq, last)
    } else {
      return false
    }

    return true
  }

  rows(width: number, maxRows = 4) {
    width = Math.max(1, width)
    const rows = ['']
    let cursorRow = 0
    const text = this.value.slice(0, this.cursor) + '▏' + this.value.slice(this.cursor)
    for (const char of text) {
      if (char === '\n') {
        rows.push('')
        continue
      }

      if (rows.at(-1) && cellWidth(rows.at(-1)) + cellWidth(char) > width) {
        rows.push('')
      }

      if (char === '▏') {
        cursorRow = rows.length - 1
      }

      rows[rows.length - 1] += char
    }

    const start = Math.max(0, cursorRow - maxRows + 1)

    return rows.slice(start, start + maxRows).map((row) => fit(row, width))
  }

  #record() {
    this.#undo.push({ value: this.value, cursor: this.cursor })
    if (this.#undo.length > UNDO_LIMIT) {
      this.#undo.shift()
    }
  }

  #replace(value: string) {
    this.value = value
    this.cursor = value.length
    this.#yank = null
  }

  #put(text: string) {
    let fitted = ''
    for (const char of text) {
      if (fitted.length + char.length > this.limit - this.value.length) break
      fitted += char
    }

    this.value = this.value.slice(0, this.cursor) + fitted + this.value.slice(this.cursor)
    this.cursor += fitted.length
    this.historyIndex = null

    return fitted
  }

  #type(text: string, last: string | null) {
    if (last !== 'type') {
      this.#record()
    }

    this.#put(sanitize(text))
    this.#last = 'type'
  }

  #markerAt(index: number): [number, number] | null {
    for (const match of this.value.matchAll(MARKER)) {
      const end = match.index + match[0].length
      if (index > match.index && index < end && this.pastes.has(match[0])) {
        return [match.index, end]
      }
    }

    return null
  }

  #span(from: number, to: number): [number, number] {
    const a = this.#markerAt(from)
    const b = this.#markerAt(to)
    return [a ? a[0] : from, b ? b[1] : to]
  }

  #prev(index: number) {
    if (index <= 0) return 0
    const before = this.value.codePointAt(index - 2)
    const step = index >= 2 && (before ?? 0) > 0xffff ? 2 : 1
    return this.#span(index - step, index)[0]
  }

  #next(index: number) {
    if (index >= this.value.length) return this.value.length
    const step = this.value.codePointAt(index)! > 0xffff ? 2 : 1
    return this.#span(index, index + step)[1]
  }

  #isWord(index: number) {
    return WORD.test(String.fromCodePoint(this.value.codePointAt(index)!))
  }

  #wordBack(index: number) {
    while (index > 0 && !this.#isWord(this.#prev(index))) {
      index = this.#prev(index)
    }

    while (index > 0 && this.#isWord(this.#prev(index))) {
      index = this.#prev(index)
    }

    return index
  }

  #wordForward(index: number) {
    const end = this.value.length
    while (index < end && !this.#isWord(index)) {
      index = this.#next(index)
    }

    while (index < end && this.#isWord(index)) {
      index = this.#next(index)
    }

    return index
  }

  #lineStart(index: number) {
    return this.value.lastIndexOf('\n', index - 1) + 1
  }

  #lineEnd(index: number) {
    const end = this.value.indexOf('\n', index)
    return end < 0 ? this.value.length : end
  }

  #delete(from: number, to: number) {
    ;[from, to] = this.#span(from, to)
    if (from >= to) {
      return ''
    }

    this.#record()
    const removed = this.value.slice(from, to)
    this.value = this.value.slice(0, from) + this.value.slice(to)
    this.cursor = from
    this.historyIndex = null

    return removed
  }

  #killBack(from: number, last: string | null) {
    const removed = this.#delete(from, this.cursor)
    if (!removed) {
      return
    }

    if (last === 'kill-back' && this.killRing.length) {
      this.killRing.push(removed + this.killRing.pop())
    } else {
      this.#ring(removed)
    }

    this.#last = 'kill-back'
  }

  #killForward(to: number, last: string | null) {
    const removed = this.#delete(this.cursor, to)
    if (!removed) {
      return
    }

    if (last === 'kill-forward' && this.killRing.length) {
      this.killRing.push(this.killRing.pop() + removed)
    } else {
      this.#ring(removed)
    }

    this.#last = 'kill-forward'
  }

  #ring(removed: string) {
    this.killRing.push(removed)
    if (this.killRing.length > RING_LIMIT) {
      this.killRing.shift()
    }
  }

  #yankLatest() {
    if (!this.killRing.length) return
    this.#record()
    const start = this.cursor
    this.#put(this.killRing.at(-1)!)
    this.#yank = { start, end: this.cursor, index: this.killRing.length - 1 }
    this.#last = 'yank'
  }

  #yankPop(last: string | null) {
    if (last !== 'yank' || !this.#yank || this.killRing.length < 2) {
      this.#last = last
      return last === 'yank'
    }

    const index = (this.#yank.index - 1 + this.killRing.length) % this.killRing.length
    this.value = this.value.slice(0, this.#yank.start) + this.value.slice(this.#yank.end)
    this.cursor = this.#yank.start
    this.#put(this.killRing[index]!)
    this.#yank = { start: this.#yank.start, end: this.cursor, index }
    this.#last = 'yank'

    return true
  }

  #jump(msg: KeyMessage): boolean {
    this.#pending = null
    const seq = msg.sequence
    if (msg.ctrl || msg.meta || typeof seq !== 'string' || seq < ' ') {
      return this.key(msg)
    }

    const found = this.value.indexOf(seq, this.#next(this.cursor))
    if (found >= 0) {
      this.cursor = found
    }

    return true
  }

  #vertical(direction: number) {
    const start = this.#lineStart(this.cursor)
    const col = this.cursor - start
    if (direction < 0) {
      if (!start) {
        return false
      }

      const end = start - 1
      this.cursor = Math.min(this.#lineStart(end) + col, end)
    } else {
      const next = this.value.indexOf('\n', this.cursor)
      if (next < 0) {
        return false
      }

      this.cursor = Math.min(next + 1 + col, this.#lineEnd(next + 1))
    }

    if (/[\udc00-\udfff]/.test(this.value[this.cursor] ?? '')) {
      this.cursor--
    }

    this.cursor = this.#span(this.cursor, this.cursor)[0]

    return true
  }
}
