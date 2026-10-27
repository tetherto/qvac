const ESC = '\x1b['
export const palette = {
  bg: '8;18;26',
  text: '212;223;230',
  muted: '139;158;171',
  teal: '43;216;189',
  green: '131;231;172',
  purple: '181;161;225',
  red: '255;174;155',
  line: '53;74;86',
  select: '19;61;60',
  added: '18;52;46',
  removed: '64;32;38'
}
const BASE = { ...palette }

// Overrides reshade existing tokens only, so every colour keeps its role; a reload starts from base.
export function applyTheme(overrides: Partial<typeof palette>) {
  Object.assign(palette, BASE, overrides)
}

export const plain = (text: unknown) =>
  String(text ?? '')
    .replace(/\x1b\][^\x07]*(?:\x07|$)/g, '')
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/[\x00-\x08\x0b-\x1f\x7f]/g, '')
const styled = (text: unknown, color: keyof typeof palette, weight: string) =>
  `${ESC}38;2;${palette[color]}m${weight}${plain(text)}${ESC}0m`
export const paint = (
  text: string | undefined,
  color: keyof typeof palette = 'text',
  bold = false
) => styled(text, color, bold ? ESC + '1m' : '')
export const strong = (text: string, color: keyof typeof palette = 'text') =>
  styled(text, color, ESC + '1m')
// A selected row: a filled bar in the selection colour.
export const highlight = (text: string, color: keyof typeof palette = 'teal') =>
  `${ESC}48;2;${palette.select}m${styled(text, color, '')}`
export const count = (n: number, word: string, many = word + 's') => `${n} ${n === 1 ? word : many}`
export const logo = [
  String.raw`  ___  __   __    _    ___ `,
  String.raw` / _ \ \ \ / /   / \  / __|`,
  String.raw`| (_) | \ V / . / _ \| (__ `,
  String.raw` \__\_\  \_/   /_/ \_\\___|`
]
export function bytes(value: unknown) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return '—'
  if (value >= 1e9) {
    return `${(value / 1e9).toFixed(1)} GB`
  }

  if (value >= 1e6) {
    return `${(value / 1e6).toFixed(0)} MB`
  }

  return `${value} B`
}

function fit(text: string, inner: number, measure: (text: string) => number) {
  let result = '',
    col = 0
  const tokens = String(text).match(/\x1b\[[0-9;]*m|[^]/gu) || []
  for (const token of tokens) {
    if (token.startsWith('\x1b[')) {
      result += token
      continue
    }

    // a row is one line: a newline or tab inside it would push every row below it down
    const cell = token === '\n' || token === '\t' ? ' ' : token
    const size = measure(cell)
    if (col + size > inner) {
      break
    }

    result += cell
    col += size
  }

  return result + ' '.repeat(Math.max(0, inner - col))
}

function paintRow(text: string, { enabled, theme }: { enabled: boolean; theme: string }) {
  if (theme !== 'qvac') {
    text = text.replaceAll(`${ESC}38;2;${palette.text}m`, `${ESC}39m`)
  }

  const base =
    theme === 'qvac' ? `${ESC}48;2;${palette.bg}m${ESC}38;2;${palette.text}m` : `${ESC}49m`

  // Erase the spare wrap-guard cell using the active background before resetting.
  return enabled
    ? `${base}${text.replaceAll(ESC + '0m', ESC + '0m' + base)}${ESC}K${ESC}0m`
    : plain(text) + ESC + 'K'
}

export function canvas({
  width,
  height,
  measure,
  color: enabled = true,
  theme = 'terminal'
}: {
  width: number
  height: number
  measure: (text: string) => number
  color?: boolean | undefined
  theme?: string | undefined
}) {
  width = Math.max(1, width - 1)
  height = Math.max(1, height)
  const pad = width > 70 ? 3 : 1,
    inner = width - 2 * pad
  const row = (text = '') => ' '.repeat(pad) + fit(text, inner, measure) + ' '.repeat(pad)
  const rule = (left = '', right = '') =>
    paint(
      left +
        ' ' +
        '─'.repeat(Math.max(1, inner - measure(left) - measure(right) - 2)) +
        ' ' +
        right,
      'muted'
    )
  const two = (a: string, b: string) =>
    a + ' '.repeat(Math.max(1, inner - measure(a) - measure(b))) + b
  // Clip styled text to width, marking the cut with an ellipsis.
  const clip = (text: string, size = inner) =>
    measure(text) <= size ? text : fit(text, Math.max(0, size - 1), measure).trimEnd() + '…'
  // Left and right on one row: the first right-hand option that fits wins, then left is clipped.
  const pair = (left: string, rights: string[]) => {
    const right = rights.find((r) => measure(left) + 1 + measure(r) <= inner) ?? ''
    return right ? two(left, right) : clip(left)
  }
  const center = (text: string) =>
    ' '.repeat(Math.max(0, Math.floor((inner - measure(text)) / 2))) + text
  const render = (lines: string[]) =>
    Array.from({ length: height }, (_, i) =>
      paintRow(row(lines[i] || ''), { enabled, theme })
    ).join('\n')

  return { inner, row, rule, two, center, render, pad, clip, pair }
}
