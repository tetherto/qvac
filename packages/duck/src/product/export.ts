import type { Turn, AgentTurn, Segment, SegmentDetail } from './transcript.js'
interface ExportItem extends Segment {
  name?: string
  args?: unknown
  result?: unknown
}
interface ExportOptions {
  title?: string
  model?: string | null | undefined
  agentName?: string | null | undefined
  date?: string | number | Date
}
const record = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === 'object' ? (value as Record<string, unknown>) : {}
const LIMIT = 2000
const failed = (value: unknown) =>
  !!(record(value)['error'] || record(value)['isError'] || record(value)['status'] === 'failed')
const json = (value: unknown) =>
  typeof value === 'string' ? value : (JSON.stringify(value, null, 2) ?? '')
const clip = (text: string, limit = LIMIT) =>
  text.length > limit ? text.slice(0, limit) + `\n… (${text.length - limit} more characters)` : text

function entries(turn: AgentTurn) {
  const out: ExportItem[] = [],
    open: ExportItem[] = []
  for (const segment of turn.segments) {
    if (segment.type === 'tool-call') {
      const row: ExportItem = {
        text: '',
        detail: {},
        type: 'tool',
        name: segment.detail.name || 'tool',
        args: segment.detail.arguments,
        result: undefined
      }
      open.push(row)
      out.push(row)
    } else if (segment.type === 'tool-result') {
      const name = segment.detail.name,
        result = segment.detail.result ?? segment.detail
      const row = open.find((r) => r.result === undefined && (!name || r.name === name))
      if (row) {
        row.result = result
      } else {
        out.push({ text: '', detail: {}, type: 'tool', name: name || 'tool', result })
      }
    } else {
      out.push(segment)
    }
  }

  return out
}

const outcome = (turn: AgentTurn) => {
  if (turn.status === 'failed') {
    return `Run failed · ${turn.run?.reason || turn.run?.error?.message || 'unknown error'}`
  }

  if (turn.status === 'canceled' || turn.status === 'cancelled') {
    return 'Stopped'
  }

  if (turn.run?.stopReason === 'length' || turn.run?.metrics?.stopReason === 'length') {
    return 'Context limit reached · the answer may be incomplete'
  }

  return null
}

const approvalLine = (d: SegmentDetail) =>
  `${d.name || 'tool'} · ${d.status || 'pending'}${d.resource ? ` · ${d.resource.kind} ${d.resource.label}` : ''}`

function fence(text: string, lang = '') {
  const ticks = '`'.repeat(Math.max(3, ...[...text.matchAll(/`+/g)].map((m) => m[0].length + 1)))
  return `${ticks}${lang}\n${text}\n${ticks}`
}

function header({ title = 'QV.AC conversation', model, agentName, date }: ExportOptions = {}) {
  const meta = [
    agentName && `Agent: ${agentName}`,
    model && `Model: ${model}`,
    date && `Date: ${new Date(date).toISOString()}`
  ].filter((value): value is string => typeof value === 'string' && !!value)
  return { title, meta }
}

function toolState(result: unknown) {
  if (result === undefined) return 'no result'
  return failed(result) ? 'failed' : 'ok'
}

function markdownTool(item: ExportItem) {
  const lines = [`<details>\n<summary>Tool: ${item.name} (${toolState(item.result)})</summary>\n`]
  if (item.args !== undefined) {
    lines.push(fence(json(item.args), 'json'))
  }

  if (item.result !== undefined) {
    lines.push(`Result:\n\n${fence(clip(json(item.result)))}`)
  }

  lines.push('</details>')

  return lines.join('\n\n')
}

const MARKDOWN_ITEMS: Record<string, (item: ExportItem) => string> = {
  content: (item: { text?: string | undefined }) => (item.text || '').trim(),
  thinking: (item: { text?: string | undefined }) =>
    (item.text || '').trim() &&
    `<details>\n<summary>Thinking</summary>\n\n${(item.text || '').trim()}\n\n</details>`,
  tool: markdownTool,
  approval: (item) => `> **Approval:** ${approvalLine(item.detail)}`,
  sources: (item) =>
    (item.detail.sources || []).map((s) => `- [${s.title || s.url}](${s.url})`).join('\n'),
  attachment: (item) => `*Attachment: ${item.detail.fileName || 'file'}*`
}

function markdownAgent(turn: AgentTurn, agent: string) {
  const body = entries(turn).map((item) => MARKDOWN_ITEMS[item.type]?.(item))
  const end = outcome(turn)
  if (end) {
    body.push(`> **${end}**`)
  }

  return `## ${agent}\n\n${body.filter(Boolean).join('\n\n')}`.trimEnd()
}

const MARKDOWN_TURNS = {
  user: (turn: Extract<Turn, { from: 'user' }>) => `## User\n\n${turn.text}`,
  file: (turn: Extract<Turn, { from: 'file' }>) =>
    `*Attached file: ${turn.file.fileName || 'file'}*`,
  compaction: () => '---\n\n*Earlier conversation was compacted.*\n\n---',
  agent: markdownAgent
}

export function toMarkdown(list: readonly Turn[], opts: ExportOptions = {}) {
  const { title, meta } = header(opts),
    agent = opts.agentName || 'Assistant'
  const parts = [`# ${title}`]
  if (meta.length) {
    parts.push(meta.join('  \n'))
  }

  for (const turn of list) {
    switch (turn.from) {
      case 'agent':
        parts.push(MARKDOWN_TURNS.agent(turn, agent))
        break
      case 'user':
        parts.push(MARKDOWN_TURNS.user(turn))
        break
      case 'file':
        parts.push(MARKDOWN_TURNS.file(turn))
        break
      case 'compaction':
        parts.push(MARKDOWN_TURNS.compaction())
        break
    }
  }

  return parts.join('\n\n') + '\n'
}

export const escapeHtml = (text: string) =>
  String(text).replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!
  )

function prose(text: string) {
  return text
    .split(/^(```[^\n]*\n[\s\S]*?\n```)$/m)
    .map((part, i: number) => {
      if (i % 2) {
        const [, lang, code] = part.match(/^```([^\n]*)\n([\s\S]*)\n```$/)!
        return `<pre><code${lang ? ` data-lang="${escapeHtml(lang.trim())}"` : ''}>${escapeHtml(code ?? '')}</code></pre>`
      }

      return part.trim() ? `<div class="prose">${escapeHtml(part.trim())}</div>` : ''
    })
    .join('')
}

const CSS = `:root{--bg:#08121a;--panel:#0d1b26;--line:#173040;--text:#d4dfe6;--muted:#8b9eab;--accent:#2bd8bd;--red:#ff6b7a;--mono:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--text);font:15px/1.6 system-ui,-apple-system,"Segoe UI",sans-serif}
main{max-width:860px;margin:0 auto;padding:32px 16px 64px}h1{font-size:22px;margin:0 0 4px}.meta{color:var(--muted);font-size:13px;margin-bottom:28px}
.turn{margin:0 0 22px}.who{font-size:12px;letter-spacing:.08em;text-transform:uppercase;color:var(--muted);margin-bottom:6px}.user .who{color:var(--accent)}
.user .body{background:var(--panel);border-left:3px solid var(--accent);padding:10px 14px;border-radius:6px}.prose{white-space:pre-wrap;overflow-wrap:anywhere;margin:6px 0}
pre{background:var(--panel);border:1px solid var(--line);border-radius:6px;padding:10px 12px;overflow-x:auto;font:13px/1.5 var(--mono);margin:8px 0;white-space:pre-wrap;overflow-wrap:anywhere}
code{font-family:var(--mono)}details{border:1px solid var(--line);border-radius:6px;margin:8px 0;padding:6px 12px}summary{cursor:pointer;color:var(--muted);font-size:13px}
summary b{color:var(--text);font-family:var(--mono);font-weight:600}details[open] summary{margin-bottom:6px}.ok{color:var(--accent)}.bad,.fail{color:var(--red)}
.note{color:var(--muted);font-size:13px;font-style:italic;margin:6px 0}.fail{font-size:13px;margin:6px 0}a{color:var(--accent)}ul{margin:6px 0;padding-left:20px}
hr{border:0;border-top:1px dashed var(--line);margin:22px 0}.label{color:var(--muted);font-size:12px;margin-top:8px}`

const HTML_STATE = {
  'no result': `<span>·</span>`,
  failed: `<span class="bad">✗</span>`,
  ok: `<span class="ok">✓</span>`
}

function htmlTool(item: ExportItem) {
  const args =
    item.args === undefined
      ? ''
      : `<pre><code data-lang="json">${escapeHtml(json(item.args))}</code></pre>`
  const result =
    item.result === undefined
      ? ''
      : `<div class="label">Result</div><pre><code>${escapeHtml(clip(json(item.result)))}</code></pre>`

  return `<details><summary>${HTML_STATE[toolState(item.result)]} <b>${escapeHtml(item.name || 'tool')}</b></summary>${args}${result}</details>`
}

const sourceLink = (s: { url?: string | null; title?: string }) =>
  `<li><a href="${/^https?:/i.test(s.url || '') ? escapeHtml(s.url || '') : '#'}">${escapeHtml(s.title || s.url || '')}</a></li>`

const HTML_ITEMS: Record<string, (item: ExportItem) => string> = {
  content: (item: { text?: string | undefined }) =>
    (item.text || '').trim() && prose((item.text || '').trim()),
  thinking: (item: { text?: string | undefined }) =>
    (item.text || '').trim() &&
    `<details><summary>Thinking</summary><div class="prose">${escapeHtml((item.text || '').trim())}</div></details>`,
  tool: htmlTool,
  approval: (item) => `<p class="note">Approval: ${escapeHtml(approvalLine(item.detail))}</p>`,
  sources: (item) => `<ul>${(item.detail.sources || []).map(sourceLink).join('')}</ul>`,
  attachment: (item) =>
    `<p class="note">Attachment: ${escapeHtml(item.detail.fileName || 'file')}</p>`
}

function htmlAgent(turn: AgentTurn, agent: string) {
  const body = entries(turn).map((item) => HTML_ITEMS[item.type]?.(item) || '')
  const end = outcome(turn)
  if (end) {
    body.push(`<p class="${turn.status === 'failed' ? 'fail' : 'note'}">${escapeHtml(end)}</p>`)
  }

  return `<section class="turn agent"><div class="who">${agent}</div>${body.join('')}</section>`
}

const HTML_TURNS = {
  user: (turn: Extract<Turn, { from: 'user' }>) =>
    `<section class="turn user"><div class="who">You</div><div class="body">${prose(turn.text)}</div></section>`,
  file: (turn: Extract<Turn, { from: 'file' }>) =>
    `<p class="note">Attached file: ${escapeHtml(turn.file.fileName || 'file')}</p>`,
  compaction: () => `<hr><p class="note">Earlier conversation was compacted.</p><hr>`,
  agent: htmlAgent
}

export function toHtml(list: readonly Turn[], opts: ExportOptions = {}) {
  const { title, meta } = header(opts),
    agent = escapeHtml(opts.agentName || 'Assistant')
  const html = list.map((turn) => {
    switch (turn.from) {
      case 'agent':
        return HTML_TURNS.agent(turn, agent)
      case 'user':
        return HTML_TURNS.user(turn)
      case 'file':
        return HTML_TURNS.file(turn)
      case 'compaction':
        return HTML_TURNS.compaction()
    }
  })

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(title)}</title><style>${CSS}</style></head>
<body><main><h1>${escapeHtml(title)}</h1><div class="meta">${meta.map(escapeHtml).join(' · ')}</div>
${html.join('\n')}
</main></body></html>
`
}

export function lastAssistantText(list: readonly Turn[]) {
  for (let i = list.length - 1; i >= 0; i--) {
    const turn = list[i]!
    if (turn.from !== 'agent') {
      continue
    }

    const segment = [...turn.segments]
      .reverse()
      .find((s) => s.type === 'content' && (s.text || '').trim())
    if (segment) {
      return (segment.text || '').trim()
    }
  }

  return ''
}
