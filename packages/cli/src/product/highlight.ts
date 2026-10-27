import { palette } from './theme.js'

const ESC = '\x1b['

const words = (list: string) => new Set(list.split(' '))

const JS = words(
  'const let var function return if else for while do switch case break continue new class ' +
    'extends import export from default async await try catch finally throw typeof instanceof ' +
    'in of yield this super null undefined true false void delete static get set interface ' +
    'type enum implements as'
)
const PY = words(
  'def class return if elif else for while in not and or is import from as with try except ' +
    'finally raise lambda yield pass break continue None True False async await global nonlocal'
)
const RUST = words(
  'fn let mut pub struct enum impl trait use mod match if else for while loop return self Self ' +
    'crate super as where async await move ref const static true false Some None Ok Err'
)
const GO = words(
  'func package import var const type struct interface map chan go defer return if else for ' +
    'range switch case default break continue select nil true false'
)
const SH = words(
  'if then else elif fi for in do done while until case esac function return export local ' +
    'echo exit set unset source'
)
const C = words(
  'int char void return if else for while do struct typedef const static unsigned long short ' +
    'double float bool true false class public private protected namespace template using new ' +
    'delete nullptr auto switch case break continue enum'
)
const JSON_WORDS = words('true false null')

// Read a line at a time: a comment or string spanning lines is coloured only where it starts.
interface Language {
  comment: string | null
  keywords: Set<string>
}
const LANGUAGES: Record<string, Language> = {
  js: { comment: '//', keywords: JS },
  py: { comment: '#', keywords: PY },
  rust: { comment: '//', keywords: RUST },
  go: { comment: '//', keywords: GO },
  sh: { comment: '#', keywords: SH },
  c: { comment: '//', keywords: C },
  json: { comment: null, keywords: JSON_WORDS },
  conf: { comment: '#', keywords: new Set() }
}

const NAMES = {
  js: ['js', 'mjs', 'cjs', 'jsx', 'ts', 'mts', 'cts', 'tsx', 'javascript', 'typescript'],
  py: ['py', 'python'],
  rust: ['rs', 'rust'],
  go: ['go', 'golang'],
  sh: ['sh', 'bash', 'zsh', 'shell', 'console'],
  c: ['c', 'h', 'cc', 'cpp', 'hpp', 'cxx', 'java', 'kt', 'swift', 'cs'],
  json: ['json', 'jsonc'],
  conf: ['yaml', 'yml', 'toml', 'ini', 'conf', 'gitignore', 'npmignore', 'dockerignore', 'env']
}

const BY_NAME = new Map(
  Object.entries(NAMES).flatMap(([lang, names]) => names.map((n) => [n, lang]))
)

// A fence tag (`ts`) or a path (`src/app.mjs`, `.gitignore`); null when nothing matches.
export function languageOf(name: string) {
  const base =
    String(name ?? '')
      .trim()
      .toLowerCase()
      .split('/')
      .pop() || ''
  const ext = base.includes('.') ? base.slice(base.lastIndexOf('.') + 1) : base

  return BY_NAME.get(ext) || null
}

const TOKEN =
  /("(?:\\.|[^"\\])*"?|'(?:\\.|[^'\\])*'?|`(?:\\.|[^`\\])*`?)|(\b\d[\w.]*)|([A-Za-z_$][\w$]*)/g

const fg = (color: string) => `${ESC}38;2;${palette[color as keyof typeof palette]}m`

function wordColor(word: string | undefined, rest: string, { keywords }: Language) {
  if (keywords.has(word ?? '')) {
    return 'purple'
  }

  return /^\s*\(/.test(rest) ? 'teal' : 'text'
}

function tokenColor(
  {
    string,
    number,
    word
  }: { string: string | undefined; number: string | undefined; word: string | undefined },
  rest: string,
  spec: Language
) {
  if (string) {
    return 'green'
  }

  return number ? 'red' : wordColor(word, rest, spec)
}

function paintTokens(text: string, spec: Language) {
  let out = '',
    at = 0
  for (const match of text.matchAll(TOKEN)) {
    const [token, string, number, word] = match
    out += fg('text') + text.slice(at, match.index)
    at = match.index + token.length
    out += fg(tokenColor({ string, number, word }, text.slice(at), spec)) + token
  }

  return out + fg('text') + text.slice(at)
}

// Foreground colours only, so a line can sit on a tinted background; the caller resets.
export function paintCode(text: string, lang: string | null) {
  const spec = LANGUAGES[lang ?? '']
  if (!spec) {
    return fg('text') + text
  }

  const at = spec.comment ? commentStart(text, spec.comment) : -1
  if (at < 0) {
    return paintTokens(text, spec)
  }

  return paintTokens(text.slice(0, at), spec) + fg('muted') + text.slice(at)
}

const QUOTES = `"'\``

// A # needs a space before it, so a#b and $# are not comments.
const opens = (text: string, i: number, marker: string) =>
  text.startsWith(marker, i) && (marker !== '#' || i === 0 || /\s/.test(text[i - 1] ?? ''))

// The first comment marker outside a string.
function commentStart(text: string, marker: string) {
  let quote: string | null = null
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!
    if (quote) {
      i += ch === '\\' ? 1 : 0
      quote = ch === quote ? null : quote
      continue
    }

    if (QUOTES.includes(ch)) {
      quote = ch
    } else if (opens(text, i, marker)) {
      return i
    }
  }

  return -1
}
