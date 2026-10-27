type Edit = [' ' | '+' | '-', number, number]
interface DiffLine {
  op: ' ' | '+' | '-'
  text: string
  oldNo: number | null
  newNo: number | null
}
interface Layout {
  digits: number
  room: number
  lang: string | null
}
interface RenderOptions {
  width: number
  maxLines?: number
  startLine?: number
  path?: unknown
}
export interface ToolArguments {
  path?: unknown
  content?: unknown
  old?: unknown
  new?: unknown
  command?: unknown
  script?: unknown
  language?: unknown
  workdir?: unknown
  cwd?: unknown
  from?: unknown
  to?: unknown
  pattern?: unknown
  query?: unknown
  dir?: unknown
  include?: unknown
  regex?: unknown
  output?: unknown
  startLine?: unknown
  endLine?: unknown
  tasks?: unknown
  [key: string]: unknown
}
interface DelegatedResult {
  status?: string
  text?: unknown
}
export interface ToolResult {
  error?: unknown
  denied?: unknown
  isError?: unknown
  exitCode?: unknown
  content?: unknown
  matches?: unknown
  truncated?: unknown
  job?: unknown
  status?: unknown
  replaced?: unknown
  replacements?: unknown
  entries?: unknown
  restorableAt?: unknown
  stdout?: unknown
  stderr?: unknown
  note?: unknown
  results?: unknown
}
export interface ToolItem {
  name: string
  args?: unknown
  result?: unknown
}
const resultOf = (value: unknown): ToolResult =>
  value !== null && typeof value === 'object' ? (value as ToolResult) : {}
const argsOf = (value: unknown): ToolArguments =>
  value !== null && typeof value === 'object' ? (value as ToolArguments) : {}
import { paint, palette } from './theme.js'
import { languageOf, paintCode } from './highlight.js'
import { wrap, cellWidth, clean } from './text.js'

const MINUS = '−'
const OMITTED = /\n?…\[(\d+) chars omitted[^\]]*\]…\n?/g

// the model writes the arguments, so a field it left out or got the type of still reads as text
function text(value: unknown) {
  if (typeof value === 'string') {
    return value
  }

  return value === null || value === undefined ? '' : (JSON.stringify(value) ?? String(value))
}

const split = (value: unknown) => {
  const s = text(value)
  if (s === '') {
    return []
  }

  const rows = s.split('\n')
  if (rows[rows.length - 1] === '') {
    rows.pop()
  }

  return rows
}

const tidy = (text: unknown) => clean(String(text).replace(/\t/g, '  '))

function cut(text: string, width: number) {
  text = tidy(text)
  if (cellWidth(text) <= width) {
    return text
  }

  let out = '',
    cells = 0
  for (const char of text) {
    const size = cellWidth(char)
    if (cells + size > width - 1) {
      break
    }

    out += char
    cells += size
  }

  return out + '…'
}

function myers(a: string[], b: string[], limit: number) {
  const n = a.length,
    m = b.length,
    max = n + m,
    off = max
  const v = new Int32Array(2 * max + 2)
  const trace: Int32Array[] = []
  for (let d = 0; d <= Math.min(max, limit); d++) {
    trace.push(v.slice(off - d, off + d + 2))
    for (let k = -d; k <= d; k += 2) {
      let x =
        k === -d || (k !== d && v[off + k - 1]! < v[off + k + 1]!)
          ? v[off + k + 1]!
          : v[off + k - 1]! + 1
      let y = x - k
      while (x < n && y < m && a[x] === b[y]) {
        ;(x++, y++)
      }

      v[off + k] = x
      if (x >= n && y >= m) {
        return backtrack(a, b, trace)
      }
    }
  }

  return null
}

function backtrack(a: string[], b: string[], trace: Int32Array[]): Edit[] {
  const ops: Edit[] = []
  let x = a.length,
    y = b.length
  for (let d = trace.length - 1; d >= 0; d--) {
    const snap = trace[d]!
    // snap holds v[-d .. d+1] as it stood before round d.
    const at = (k: number) => snap[k + d]!
    const k = x - y
    const prevK = k === -d || (k !== d && at(k - 1) < at(k + 1)) ? k + 1 : k - 1
    const prevX = d === 0 ? 0 : at(prevK)
    const prevY = d === 0 ? 0 : prevX - prevK
    while (x > prevX && y > prevY) {
      ops.push([' ', --x, --y])
    }

    if (d > 0) {
      if (x === prevX) {
        ops.push(['+', x, --y])
      } else {
        ops.push(['-', --x, y])
      }
    }
  }

  return ops.reverse()
}

function editScript(a: string[], b: string[]): Edit[] {
  const size = a.length + b.length
  // Myers is O((n+m)·d); huge inputs get a bounded edit distance before falling back.
  const limit = a.length * b.length > 4e6 ? Math.floor(4e6 / size) : size

  return (
    myers(a, b, limit) ?? [
      ...a.map((_, i): Edit => ['-', i, b.length]),
      ...b.map((_, j): Edit => ['+', a.length, j])
    ]
  )
}

export function diffLines(oldText: unknown, newText: unknown): DiffLine[] {
  const a = split(oldText),
    b = split(newText)
  let start = 0
  while (start < a.length && start < b.length && a[start] === b[start]) {
    start++
  }

  let endA = a.length,
    endB = b.length
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    ;(endA--, endB--)
  }

  const midA = a.slice(start, endA),
    midB = b.slice(start, endB)
  const mid = editScript(midA, midB)
  const out: DiffLine[] = []
  for (let i = 0; i < start; i++) {
    out.push({ op: ' ', text: a[i]!, oldNo: i + 1, newNo: i + 1 })
  }

  for (const [op, i, j] of mid) {
    out.push({
      op,
      text: op === '+' ? midB[j]! : midA[i]!,
      oldNo: op === '+' ? null : start + i + 1,
      newNo: op === '-' ? null : start + j + 1
    })
  }

  for (let i = endA, j = endB; i < a.length; i++, j++) {
    out.push({ op: ' ', text: a[i]!, oldNo: i + 1, newNo: j + 1 })
  }

  return out
}

export function diffStat(oldText: unknown, newText: unknown) {
  let added = 0,
    removed = 0
  for (const line of diffLines(oldText, newText)) {
    if (line.op === '+') {
      added++
    } else if (line.op === '-') {
      removed++
    }
  }

  return { added, removed }
}

function changeGroups(lines: DiffLine[], context: number) {
  const groups: { start: number; end: number }[] = []
  lines.forEach((l: { op: string }, i: number) => {
    if (l.op === ' ') {
      return
    }

    const last = groups[groups.length - 1]
    if (last && i - last.end <= 2 * context + 1) {
      last.end = i
    } else {
      groups.push({ start: i, end: i })
    }
  })

  return groups
}

export function hunks(lines: DiffLine[], context = 3) {
  return changeGroups(lines, context).map(({ start, end }) => {
    const from = Math.max(0, start - context),
      to = Math.min(lines.length - 1, end + context)
    const slice = lines.slice(from, to + 1)
    const head = lines.slice(0, from)
    const oldBefore = head.filter((l: { op: string }) => l.op !== '+').length
    const newBefore = head.filter((l: { op: string }) => l.op !== '-').length
    const oldCount = slice.filter((l: { op: string }) => l.op !== '+').length
    const newCount = slice.filter((l: { op: string }) => l.op !== '-').length
    const oldStart = oldCount ? oldBefore + 1 : oldBefore
    const newStart = newCount ? newBefore + 1 : newBefore

    return {
      header: `@@ -${oldStart},${oldCount} +${newStart},${newCount} @@`,
      oldStart,
      oldCount,
      newStart,
      newCount,
      lines: slice
    }
  })
}

const ESC = '\x1b['
const MARKS: Record<
  DiffLine['op'],
  { mark: string; color: keyof typeof palette; tint: keyof typeof palette | null }
> = {
  '+': { mark: '+', color: 'green', tint: 'added' },
  '-': { mark: MINUS, color: 'red', tint: 'removed' },
  ' ': { mark: ' ', color: 'muted', tint: null }
}

const more = (n: number, width: number) =>
  paint(cut(`… ${n} more line${n === 1 ? '' : 's'}`, width), 'muted')

// The code keeps its syntax colours; an added or removed line is tinted across its full width.
function codeRow(
  { no, op, text }: { no: number; op: DiffLine['op']; text: string },
  { digits, room, lang }: Layout
) {
  const { mark, color, tint } = MARKS[op]
  const code = cut(text, room)
  const fill = tint ? ' '.repeat(Math.max(0, room - cellWidth(code))) : ''
  const lead = tint ? `${ESC}48;2;${palette[tint]}m` : ''

  return (
    paint(String(no).padStart(digits), 'muted') +
    ' ' +
    lead +
    `${ESC}38;2;${palette[color]}m${mark} ` +
    paintCode(code, lang) +
    fill +
    `${ESC}0m`
  )
}

function capped(rows: string[], maxLines: number, width: number) {
  if (rows.length <= maxLines) {
    return rows
  }

  return [...rows.slice(0, maxLines), more(rows.length - maxLines, width)]
}

export function renderDiff(
  oldText: unknown,
  newText: unknown,
  { width, maxLines = 40, startLine = 1, path }: RenderOptions
) {
  const groups = hunks(diffLines(oldText, newText))
  if (!groups.length) {
    return []
  }

  const shift = startLine - 1
  const top = groups.reduce(
    (n, g) => Math.max(n, ...g.lines.map((l) => (l.newNo ?? l.oldNo ?? 0) + shift)),
    1
  )
  const layout: Layout = { digits: String(top).length, lang: languageOf(text(path)), room: 0 }
  layout.room = Math.max(1, width - layout.digits - 3)
  const rows: string[] = []
  groups.forEach((g, i) => {
    if (i) {
      rows.push(paint(cut(' '.repeat(layout.digits) + ' ⋯', width), 'line'))
    }

    for (const l of g.lines) {
      rows.push(codeRow({ no: ((l.op === '-' ? l.oldNo : l.newNo) ?? 0) + shift, ...l }, layout))
    }
  })

  return capped(rows, maxLines, width)
}

// A file whose earlier text is unknown: what it holds now, not a diff against nothing.
export function renderCode(source: unknown, { width, maxLines = 40, path }: RenderOptions) {
  const lines = split(source)
  const layout: Layout = {
    digits: String(lines.length).length,
    lang: languageOf(text(path)),
    room: 0
  }
  layout.room = Math.max(1, width - layout.digits - 3)

  return capped(
    lines.map((text, i) => codeRow({ no: i + 1, op: ' ', text }, layout)),
    maxLines,
    width
  )
}

// a path the model left out, or gave as something else, reads as missing
const named = (value: unknown, what: string) =>
  typeof value === 'string' && value.trim() ? value : `(no ${what})`
const count = (n: number, word: string, many = word + 's') => `${n} ${n === 1 ? word : many}`
const lineCount = (text: unknown) => split(text).length
const stat = ({ added, removed }: { added: number; removed: number }) =>
  `+${added} ${MINUS}${removed}`
const firstLine = (text: unknown) => String(text ?? '').split('\n')[0]!
const firstString = (args: unknown): string =>
  args && typeof args === 'object'
    ? (Object.values(args).find((v): v is string => typeof v === 'string') ?? '')
    : String(args ?? '')

function failedOf(name: string, result: ToolResult) {
  if (!result || typeof result !== 'object') return false
  if (result.error || result.denied) return true
  return (
    (name === 'exec' || name === 'shell') &&
    typeof result.exitCode === 'number' &&
    result.exitCode !== 0
  )
}

const truncated = (r: ToolResult) => (r.truncated ? '+' : '')

function readDetail(a: ToolArguments, r: ToolResult) {
  const head = firstLine(r?.content)
  if (/^lines\s/.test(head)) {
    return head
  }

  if (a.startLine) {
    return `lines ${a.startLine}-${a.endLine ?? 'end'}`
  }

  return ''
}

// how the model asked matters as much as what: a literal search for a|b once looked like a regex
function grepTitle(a: ToolArguments) {
  const pattern = text(a.pattern ?? a.query ?? firstString(a))
  const where = [a.dir && `in ${text(a.dir)}`, a.include && text(a.include)].filter(Boolean)

  return [`Search ${a.regex === true ? `/${pattern}/` : `"${pattern}"`}`, ...where].join(' ')
}

function grepDetail(a: ToolArguments, r: ToolResult) {
  const m = r?.matches
  if (m === undefined) {
    return ''
  }

  // the harness explains an empty answer after "no matches", e.g. that it searched plain text
  if (text(m).startsWith('no matches')) {
    return text(m)
  }

  // too broad to show as lines, the harness answers with the files and says how many
  const broad = /^(\d+\+? matches in \d+\+? files), too many/.exec(text(m))
  if (broad) {
    return `${broad[1]} · narrow it`
  }

  const n = split(m).length

  return a.output === 'files' || a.output === 'count'
    ? count(n, 'file') + truncated(r)
    : count(n, 'match', 'matches') + truncated(r)
}

function runDetail(r: ToolResult) {
  if (r?.job !== undefined) {
    return `background · ${r.status ?? 'started'}`
  }

  if (typeof r?.exitCode === 'number') {
    return `exit ${r.exitCode}`
  }

  return ''
}

function runHeadline(a: ToolArguments, r: ToolResult): [string, string] {
  const cmd = text(a.command) || (a.script ? `${text(a.language)} script`.trim() : '')
  return [`Run ${firstLine(cmd)}`, runDetail(r)]
}

function writeHeadline(a: ToolArguments, r: ToolResult, before?: string): [string, string] {
  if (before !== undefined) {
    return [`Write ${named(a.path, 'path')}`, stat(diffStat(before, a.content))]
  }

  return [
    `Write ${named(a.path, 'path')}`,
    (r?.replaced ? 'overwrote' : 'new file') + ` · ${count(lineCount(a.content), 'line')}`
  ]
}

// Local tasks are plain strings; with external targets each names its target.
function delegated(a: ToolArguments) {
  return (Array.isArray(a.tasks) ? a.tasks : []).map(delegatedTask)
}

// the model writes the task list, so an entry may be a string, an object or nothing usable
function delegatedTask(t: unknown) {
  if (!t || typeof t !== 'object') {
    return { task: text(t), target: 'local' }
  }

  return {
    task: text(('task' in t ? t.task : undefined) ?? firstString(t)),
    target: text('target' in t ? t.target : undefined) || 'local'
  }
}

const delegateResults = (r: ToolResult): DelegatedResult[] | null =>
  Array.isArray(r?.results)
    ? r.results.filter((x): x is DelegatedResult => x && typeof x === 'object')
    : null

function delegateDetail(tasks: { task: string; target: string }[], r: ToolResult) {
  const results = delegateResults(r)
  if (!results) {
    return tasks.length ? `${tasks.length} running` : ''
  }

  const answered = results.filter((x) => x.status === 'answered').length
  const other = results.length - answered

  return [answered && `${answered} answered`, other && `${other} not answered`]
    .filter(Boolean)
    .join(' · ')
}

const TASK_MARKS: Record<string, [string, keyof typeof palette]> = {
  answered: ['✓', 'green'],
  paused: ['⏸', 'muted'],
  aborted: ['■', 'muted'],
  denied: ['✗', 'red'],
  budget: ['…', 'red'],
  error: ['✗', 'red']
}

function delegateBody(
  a: ToolArguments,
  r: ToolResult,
  { width, expand }: { width: number; expand: boolean }
) {
  const results = delegateResults(r) ?? []
  const rows: string[] = []
  delegated(a).forEach(({ task, target }, i: number) => {
    const done = results[i]
    const [mark, color] = done
      ? TASK_MARKS[done.status ?? ''] || (['·', 'muted'] as const)
      : (['◌', 'teal'] as const)
    const who = target === 'local' ? '' : `${target} · `
    rows.push(paint(mark + ' ', color) + paint(cut(who + firstLine(task), width - 2), 'text'))
    if (done?.text) {
      const answer = paintRows(
        text(done.text).trim(),
        width - 2,
        done.status === 'answered' ? 'muted' : 'red'
      )
      rows.push(...(expand ? answer : answer.slice(0, 2)).map((row) => '  ' + row))
    }
  })

  return rows
}

const HEADLINES: Record<
  string,
  (args: ToolArguments, result: ToolResult, before?: string) => [string, string]
> = {
  delegate: (a, r) => {
    const tasks = delegated(a)
    return [`Delegate ${count(tasks.length, 'task')}`, delegateDetail(tasks, r)]
  },
  edit_file: (a, r) => [
    `Edit ${named(a.path, 'path')}`,
    stat(diffStat(a.old, a.new)) +
      (typeof r.replacements === 'number' && r.replacements > 1
        ? ` · ${r.replacements} replacements`
        : '')
  ],
  write_file: writeHeadline,
  read_file: (a, r) => [`Read ${named(a.path, 'path')}`, readDetail(a, r)],
  list_dir: (a, r) => [
    `List ${typeof a.path === 'string' && a.path ? a.path : '.'}`,
    r?.entries === undefined
      ? ''
      : count(split(r.entries).length, 'entry', 'entries') + truncated(r)
  ],
  glob: (a, r) => [
    `Find ${text(a.pattern ?? firstString(a))}`,
    !Array.isArray(r.matches) ? '' : count(r.matches.length, 'file') + truncated(r)
  ],
  grep: (a, r) => [grepTitle(a), grepDetail(a, r)],
  exec: runHeadline,
  shell: runHeadline,
  move_file: (a) => [`Move ${named(a.from, 'source')} → ${named(a.to, 'target')}`, ''],
  copy_file: (a) => [`Copy ${named(a.from, 'source')} → ${named(a.to, 'target')}`, ''],
  make_dir: (a) => [`Create ${named(a.path, 'path')}`, ''],
  trash_file: (a, r) => [`Trash ${named(a.path, 'path')}`, r?.restorableAt ? 'restorable' : '']
}

export function toolSummary(
  { name, args, result: rawResult }: ToolItem,
  { before }: { before?: string | undefined } = {}
) {
  const a = argsOf(args)
  const result = resultOf(rawResult)
  const head = HEADLINES[name]
  const [title, detail] = head ? head(a, result, before) : [name, firstString(a)]
  const failed = failedOf(name, result)
  if (result?.denied) {
    return { title, detail: 'denied', failed }
  }

  if (result?.error) {
    return { title, detail: cut(firstLine(text(result.error)), 60), failed }
  }

  return { title, detail, failed }
}

const paintRows = (text: string, width: number, color: keyof typeof palette | undefined) =>
  String(text ?? '')
    .split('\n')
    .flatMap((line) => wrap(tidy(line), width).map((r) => paint(r, color)))

function output(result: ToolResult, width: number, expand: boolean) {
  const rows: string[] = []
  const push = (value: unknown, color: keyof typeof palette) => {
    const parts = text(value).split(OMITTED)
    parts.forEach((part, i) => {
      if (i % 2) {
        rows.push(paint(cut(`… ${part} chars omitted`, width), 'teal'))
        return
      }

      for (const line of split(part)) {
        rows.push(...paintRows(line, width, color))
      }
    })
  }
  push(result.stdout, 'muted')
  push(result.stderr, 'red')
  if (result.job !== undefined && result.note) {
    rows.push(...paintRows(text(result.note), width, 'muted'))
  }

  if (expand || rows.length <= 6) {
    return rows
  }

  const hidden = rows.length - 6

  return [paint(cut(`… ${count(hidden, 'earlier line')}`, width), 'muted'), ...rows.slice(-6)]
}

function listing(name: string, result: ToolResult): string[] {
  if (name === 'read_file') {
    return split(result.content).slice(1)
  }

  if (name === 'list_dir') {
    return split(result.entries)
  }

  if (name === 'glob') {
    return Array.isArray(result.matches) ? result.matches.map(text) : []
  }

  if (name === 'grep') {
    return split(result.matches)
  }

  return []
}

function writeLimit(expand: boolean, before: string | undefined) {
  if (expand) return Infinity
  return before === undefined ? 8 : 12
}

export function renderToolBody(
  { name, args, result: rawResult }: ToolItem,
  {
    width,
    expand = false,
    before
  }: { width: number; expand?: boolean; before?: string | undefined }
) {
  const a = argsOf(args)
  const result = resultOf(rawResult)
  if (result?.error) {
    const rows = paintRows(text(result.error), width, 'red')
    return expand ? rows : rows.slice(0, 3)
  }

  if (name === 'edit_file') {
    return renderDiff(a.old, a.new, { width, maxLines: expand ? Infinity : 12, path: a.path })
  }

  if (name === 'delegate') {
    return delegateBody(a, result, { width, expand })
  }

  if (name === 'write_file') {
    const maxLines = writeLimit(expand, before)
    return before === undefined && result?.replaced
      ? renderCode(a.content, { width, maxLines, path: a.path })
      : renderDiff(before ?? '', a.content, { width, maxLines, path: a.path })
  }

  if (!result) {
    return []
  }

  if (name === 'exec' || name === 'shell') {
    return output(result, width, expand)
  }

  if (!expand) {
    return []
  }

  const items = listing(name, result)
  const rows = items.slice(0, 20).map((l) => paint(cut(l, width), 'muted'))
  if (items.length > 20) {
    rows.push(more(items.length - 20, width))
  }

  return rows
}

function runPreview(a: ToolArguments, width: number) {
  const rows = a.command ? paintRows(`$ ${text(a.command)}`, width, 'text') : []
  if (a.script) {
    const lines = split(a.script)
    rows.push(...lines.slice(0, 8).map((l) => paint(cut(l, width), 'muted')))
    if (lines.length > 8) {
      rows.push(more(lines.length - 8, width))
    }
  }

  const dir = a.workdir ?? a.cwd
  if (dir) {
    rows.push(paint(cut(`in ${dir}`, width), 'muted'))
  }

  return rows
}

export function renderApprovalPreview(
  { name, args }: ToolItem,
  { width, before }: { width: number; before?: string | undefined }
) {
  const a = argsOf(args)
  switch (name) {
    case 'edit_file':
      return renderDiff(a.old, a.new, { width, maxLines: 12, path: a.path })
    case 'write_file':
      return renderDiff(before ?? '', a.content, { width, maxLines: 12, path: a.path })
    case 'exec':
    case 'shell':
      return runPreview(a, width)
    case 'move_file':
    case 'copy_file':
      return paintRows(`${named(a.from, 'source')} → ${named(a.to, 'target')}`, width, 'text')
    case 'trash_file':
    case 'make_dir':
      return paintRows(named(a.path, 'path'), width, 'text')
    default: {
      const first = firstString(a)
      return first ? paintRows(first, width, 'muted').slice(0, 3) : []
    }
  }
}
