import type { Turn, AgentTurn, UserTurn, Segment, SegmentDetail } from './transcript.js'
interface ToolRow extends Segment {
  name: string
  args?: unknown
  result?: unknown
}
type Row = Segment & { name?: string; args?: unknown; result?: unknown }
export interface RenderOptions {
  agentName?: string | undefined
  expand?: boolean | undefined
  thinking?: boolean | undefined
  spin?: string | undefined
  before?: (path?: unknown) => string | null | undefined
  cwd?: string | undefined
  elapsed?: number | undefined
}
interface View {
  body: number
  agentName: string
  expand: boolean
  thinking: boolean
  spin: string
  before(path?: unknown): string | null | undefined
  cwd: string
  elapsed: number
  live?: boolean
  streaming?: boolean
}
import { paint, palette, strong, plain } from './theme.js'
import { wrap, cellWidth, fit } from './text.js'
import { settled } from './transcript.js'
import { toolSummary, renderToolBody, renderApprovalPreview } from './tool-view.js'
import { languageOf, paintCode } from './highlight.js'

const ESC = '\x1b['
const CONTEXT_LEAD = 'The following context files contain project instructions'

function inline(row: string) {
  const base = `${ESC}38;2;${palette.text}m`
  return (
    base +
    row
      .replace(/`([^`]+)`/g, (_, code) => `${ESC}38;2;${palette.green}m${code}${base}`)
      .replace(/\*\*([^*]+)\*\*/g, (_, b) => `${ESC}1m${b}${ESC}22m`) +
    `${ESC}0m`
  )
}

function markdown(text: unknown, width: number) {
  const out = []
  let fence = false,
    lang: string | null = null
  for (const line of String(text).split('\n')) {
    if (line.trimStart().startsWith('```')) {
      fence = !fence
      const tag = line.trim().slice(3)
      lang = languageOf(tag)
      out.push(paint(fence ? `┌ ${tag || 'code'}` : '└', 'line'))
      continue
    }

    if (fence) {
      for (const row of wrap(line || ' ', width - 2)) {
        out.push(
          paint('│ ', 'line') + (lang ? paintCode(row, lang) + `${ESC}0m` : paint(row, 'green'))
        )
      }

      continue
    }

    const heading = line.match(/^#{1,6}\s+(.*)/)
    if (heading) {
      out.push(...wrap(heading[1]!, width).map((r) => strong(r)))
      continue
    }

    const bullet = line.match(/^(\s*)([-*]|\d+\.)\s+(.*)/)
    if (bullet) {
      const lead = bullet[1]! + (/\d/.test(bullet[2]!) ? bullet[2]! : '•') + ' '
      wrap(bullet[3]!, width - lead.length).forEach((row, i) =>
        out.push((i ? ' '.repeat(lead.length) : paint(lead, 'teal')) + inline(row))
      )
      continue
    }

    out.push(...wrap(line, width).map(inline))
  }

  return out
}

function pairTools(turn: AgentTurn) {
  const out: Row[] = [],
    open: ToolRow[] = []
  for (const segment of turn.segments) {
    if (segment.type === 'tool-call') {
      const row: ToolRow = {
        type: 'tool',
        text: '',
        detail: {},
        name: segment.detail.name || 'tool',
        args: segment.detail.arguments,
        result: undefined
      }
      open.push(row)
      out.push(row)
    } else if (segment.type === 'tool-result') {
      const name = segment.detail.name
      const row = open.find((r) => r.result === undefined && (!name || r.name === name))
      if (row) {
        row.result = segment.detail.result ?? segment.detail
      } else {
        out.push({
          type: 'tool',
          text: '',
          detail: {},
          name: name || 'tool',
          result: segment.detail.result ?? segment.detail
        })
      }
    } else {
      out.push(segment)
    }
  }

  return out
}

function userLines(turn: UserTurn, view: { body: number }) {
  const lines = []
  let text = turn.text
  if (text.startsWith(CONTEXT_LEAD)) {
    const files = [...text.matchAll(/<context file="([^"]+)">/g)].map((m) =>
      m[1]!.split('/').slice(-2).join('/')
    )
    text = text.slice(text.lastIndexOf('</context>') + 10).trimStart()
    lines.push(paint(`  ↳ project context · ${files.join(', ')}`, 'muted'))
  }

  const rows = wrap(text, view.body - 2)
  lines.push(...rows.map((r, i) => strong(i ? '  ' : '❯ ', 'teal') + strong(r)), '')

  return lines
}

function decidedLine(detail: SegmentDetail) {
  const approved = detail.status === 'approved'
  return paint(
    `  ${approved ? '✓' : '✗'} ${detail.name} · ${detail.status}`,
    approved ? 'green' : 'red'
  )
}

// Paths inside the project folder read relative to it.
function relative(text: string, cwd: string) {
  if (!cwd) return text
  return text.replace(
    new RegExp(`(^|\\s)${cwd.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/`, 'g'),
    '$1'
  )
}

// One row of the approval box: content padded (or clipped) so the right border lines up.
function boxRow(content: string, inner: number) {
  const size = cellWidth(content)
  const row = size > inner ? paint(fit(plain(content), inner), 'muted') : content
  return paint('  │ ', 'red') + row + ' '.repeat(Math.max(0, inner - size)) + paint(' │', 'red')
}

function approvalLines(item: Segment, view: View) {
  if (item.detail.status !== 'pending' || !view.live) {
    return [decidedLine(item.detail)]
  }

  const { body, before, cwd } = view
  const inner = body - 6
  const { name = 'tool', arguments: args, resource } = item.detail
  const intent = item.intent ? wrap(item.intent, inner).slice(0, 2) : []
  const preview = renderApprovalPreview(
    { name, args },
    { width: inner, before: before(args?.['path']) ?? undefined }
  )
  const keys =
    strong('y', 'teal') +
    ' allow once   ' +
    strong('a', 'teal') +
    ' always   ' +
    strong('n', 'teal') +
    ' deny'
  const rows = [
    strong(item.detail.display?.label || name) +
      (resource ? paint(` · ${relative(resource.label, cwd)}`, 'muted') : ''),
    ...intent.map((r) => paint(r, 'muted')),
    ...preview,
    keys
  ]

  return [
    '',
    paint('  ╭─ Approval needed ' + '─'.repeat(Math.max(0, body - 22)) + '╮', 'red'),
    ...rows.map((r) => boxRow(r, inner)),
    paint('  ╰' + '─'.repeat(Math.max(0, body - 4)) + '╯', 'red')
  ]
}

function toolMark(item: Row, failed: boolean) {
  // A call in flight: the live line under the turn carries the spinner.
  if (item.result === undefined) {
    return paint('·', 'muted')
  }

  return failed ? paint('✗', 'red') : paint('✓', 'green')
}

function toolRows(item: Row, view: View) {
  const { body, expand } = view
  const known =
    view.before(
      item.args && typeof item.args === 'object' && 'path' in item.args ? item.args.path : undefined
    ) ?? undefined
  const { title, detail, failed } = toolSummary(
    { name: item.name || 'tool', args: item.args, result: item.result },
    {
      before: known
    }
  )
  const room = Math.max(4, body - 6 - cellWidth(detail || ''))
  const head = cellWidth(title) > room ? [...title].slice(0, room - 1).join('') + '…' : title
  // A pending call shows only its headline (the approval card previews it); a delegation, its tasks.
  const rows =
    item.result === undefined && item.name !== 'delegate'
      ? []
      : renderToolBody(
          { name: item.name || 'tool', args: item.args, result: item.result },
          { width: body - 4, expand, before: known }
        )

  // A failure's reason is already the body, so the headline does not repeat it.
  const note = failed && rows.length ? '' : detail

  return [
    `  ${toolMark(item, failed)} ` +
      strong(head) +
      (note ? paint(`  ${note}`, failed ? 'red' : 'muted') : ''),
    ...rows.map((row: string) => '    ' + row)
  ]
}

const chars = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n))

// Live while it is the newest step of a running turn; a finished line once anything follows.
function thinkingLines(item: { text?: string | undefined }, view: View) {
  const text = (item.text || '').trim()
  const head = view.streaming
    ? paint(`  ${view.spin} Thinking… ${Math.floor(view.elapsed / 1000)}s`, 'teal')
    : paint('  ✓ ', 'green') + paint(`Thought · ${chars(text.length)} chars`, 'muted')
  const open = view.thinking || view.expand

  return [head, ...(open ? wrap(text, view.body - 4).map((r) => paint('    ' + r, 'muted')) : [])]
}

const ITEMS: Record<string, (item: Row, view: View) => string[]> = {
  content: (item: { text?: string | undefined }, view: View) =>
    markdown((item.text || '').trim(), view.body),
  thinking: thinkingLines,
  sources: (item, view: { body: number }) =>
    (item.detail.sources || []).flatMap((s) =>
      wrap(`↗ ${s.title || s.url}`, view.body - 2).map((r) => paint('  ' + r, 'purple'))
    ),
  attachment: (item) => [paint(`  ↳ ${item.detail.fileName || 'Attachment'}`, 'purple')],
  approval: approvalLines
}

function itemLines(item: Row, view: View) {
  const render = ITEMS[item.type]
  if (render) {
    return render(item, view)
  }

  return item.name ? toolRows(item, view) : []
}

function endLines(turn: AgentTurn, view: { body: number }) {
  const lines = []
  if (turn.run?.stopReason === 'length' || turn.run?.metrics?.stopReason === 'length') {
    lines.push(paint('  Context limit reached · the answer may be incomplete', 'red'))
  }

  if (turn.status === 'failed') {
    lines.push(
      ...wrap(`Run failed · ${turn.run?.reason || 'see /status'}`, view.body - 2).map((r) =>
        paint('  ' + r, 'red')
      )
    )
  }

  if (turn.status === 'canceled' || turn.status === 'cancelled') {
    lines.push(paint('  Stopped', 'muted'))
  }

  if (turn.status === 'completed' && !answered(turn)) {
    const why = turn.run?.reason || turn.run?.metrics?.stopReason
    lines.push(
      paint(`  Ended without an answer${why ? ` · ${why}` : ''} · ask again or rephrase`, 'red')
    )
  }

  return lines
}

// Prose and the steps around it are separated by a blank line.
const breaksBefore = (item: { type: string }, previous: { type: string }) =>
  (item.type === 'content') !== (previous.type === 'content')

const answered = (turn: AgentTurn) =>
  turn.segments.some(
    (s: { type: string; text?: string | undefined }) =>
      s.type === 'content' && (s.text || '').trim()
  )

function agentLines(turn: AgentTurn, view: View) {
  // Core gave this run's message to the run before it, which answered it there
  if (turn.run?.reason === 'steered') {
    return [paint('  ↳ answered in the turn above', 'muted'), '']
  }

  const live = !settled(turn)
  // A model often emits blank text between steps; it is not part of the answer.
  const items = pairTools(turn).filter(
    (item) => item.type !== 'content' || (item.text || '').trim()
  )
  const last = items.at(-1)
  const streaming = live && last?.type === 'thinking'

  return [
    strong(`◆ ${view.agentName}`, 'teal'),
    ...items.flatMap((item, i) => [
      ...(i && breaksBefore(item, items[i - 1]!) ? [''] : []),
      ...itemLines(item, { ...view, live, streaming: streaming && item === last })
    ]),
    ...(live && !streaming ? [paint(`  ${view.spin} ${activity(turn, last, view)}`, 'teal')] : []),
    ...endLines(turn, view),
    ''
  ]
}

// What the running turn is doing right now, shown under the steps taken so far.
function activity(turn: AgentTurn, last: Row | undefined, view: View) {
  if (turn.segments.some((s) => s.type === 'approval' && s.detail.status === 'pending')) {
    return 'Waiting for your approval'
  }

  if (last?.name && last.result === undefined) {
    const { title } = toolSummary({ name: last.name, args: last.args })
    return `Running ${last.name} ${title.split(' ').slice(1).join(' ')}`.trimEnd() + '…'
  }

  const phase = turn.run?.progress?.phase
  if (!phase || phase === 'generating') {
    return last?.type === 'content' ? 'Writing…' : progressText(turn, view.elapsed)
  }

  return progressText(turn, view.elapsed)
}

const TURNS = {
  user: userLines,
  file: (turn: Extract<Turn, { from: 'file' }>) => [
    paint(`  ↳ ${turn.file.fileName || 'Attachment'} attached`, 'purple'),
    ''
  ],
  compaction: () => [paint('  ─ earlier turns summarised to save context ─', 'muted'), ''],
  agent: agentLines
}

export function renderTurns(list: readonly Turn[], width: number, opts: RenderOptions = {}) {
  const {
    agentName = 'QV.AC',
    expand = false,
    thinking = expand,
    spin = '·',
    before = () => undefined,
    cwd = '',
    elapsed = 0
  } = opts
  const view = {
    body: Math.max(8, width - 2),
    agentName,
    expand,
    thinking,
    spin,
    before,
    cwd,
    elapsed
  }

  let running = false

  return list.flatMap((turn) => {
    const live = turn.from === 'agent' && !settled(turn)
    // a message sent while a run is going waits for that run to take it at its next step
    const waiting = turn.from === 'agent' && live && running && !turn.segments.length
    running ||= live

    if (waiting) return WAITING
    switch (turn.from) {
      case 'agent':
        return TURNS.agent(turn, view)
      case 'user':
        return TURNS.user(turn, view)
      case 'file':
        return TURNS.file(turn)
      case 'compaction':
        return TURNS.compaction()
    }
  })
}

const WAITING = [paint('  ↳ waiting: the running turn reads this at its next step', 'muted'), '']

export function progressText(turn: AgentTurn | null | undefined, elapsed: number) {
  const p = turn?.run?.progress
  if (p?.phase === 'loading') {
    return `Loading ${p.model}`
  }

  if (p?.phase === 'downloading') {
    return `Downloading ${p.model} · ${Math.round(p.percentage ?? 0)}%`
  }

  if (p?.phase === 'awaiting-download') {
    return `Waiting for ${p.model} to download`
  }

  if (p?.phase === 'queued') {
    return 'Queued behind another chat'
  }

  if (p?.phase === 'compacting') {
    return 'Summarising earlier turns'
  }

  if (p?.phase === 'generating') {
    return `Generating · ${Math.round(p.percentage ?? 0)}%`
  }

  return `Working · ${Math.floor(elapsed / 1000)}s`
}
