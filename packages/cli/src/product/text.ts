export function clean(value: unknown) {
  return String(value ?? '')
    .replace(/\x1b\][^\x07]*(?:\x07|$)/g, '')
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/[\x00-\x1f\x7f-\x9f]/g, ' ')
}

export function cellWidth(value: string | undefined) {
  return [...clean(value)].reduce((width, char) => {
    const n = char.codePointAt(0)!
    if (/\p{Mark}/u.test(char) || n === 0x200d || n === 0xfe0f) {
      return width
    }

    return (
      width +
      (n >= 0x1100 &&
      (n <= 0x115f ||
        (n >= 0x2e80 && n <= 0xa4cf) ||
        (n >= 0xac00 && n <= 0xd7a3) ||
        (n >= 0xf900 && n <= 0xfaff) ||
        (n >= 0xfe10 && n <= 0xfe6f) ||
        (n >= 0xff01 && n <= 0xff60) ||
        n >= 0x1f300)
        ? 2
        : 1)
    )
  }, 0)
}

export function fit(value: string, width: number) {
  let result = '',
    cells = 0
  for (const char of clean(value)) {
    const size = cellWidth(char)
    if (cells + size > width) {
      break
    }

    result += char
    cells += size
  }

  return result + ' '.repeat(Math.max(0, width - cells))
}

// Word wrap on plain text; colour is applied per row afterwards so escapes are never split.
export function wrap(value: string | undefined, width: number) {
  width = Math.max(1, width)
  const rows = []
  let line = ''
  for (const word of clean(value).match(/\s+|\S+/gu) || []) {
    if (line && !/^\s+$/.test(word) && cellWidth(word) <= width && cellWidth(line + word) > width) {
      rows.push(line.trimEnd())
      line = ''
    }

    for (const char of word) {
      if (cellWidth(line + char) > width) {
        rows.push(line)
        line = ''
      }

      if (!line && char === ' ' && rows.length) {
        continue
      }

      line += char
    }
  }

  if (line) {
    rows.push(line)
  }

  return rows.length ? rows : ['']
}
