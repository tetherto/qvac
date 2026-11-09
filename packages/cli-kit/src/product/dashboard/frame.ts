import type { Frame } from '../app-types.js'
import type { Dashboard } from './app.js'
import { paint, strong } from '../theme.js'
import { paragraph, keyHints } from '../ink.js'

// The dashboard frame: header, the page a product names, and the footer with its key hints.
export interface Page {
  body: string[] | ((room: number) => string[])
  header?: string[]
  nav?: boolean
  hints?: string[][]
  aside?: string[][]
}
export type PageView = (app: Dashboard, f: Frame) => Page

// pages: what each page name renders; the product composes its own table
export function renderDashboard(app: Dashboard, f: Frame, pages: Record<string, PageView>) {
  const render = app.ready ? pages[app.page] || blankPage : startingPage
  const page = render(app, f)
  const header = page.header || [
    ...app.header(f),
    '',
    f.rule(app.page.toUpperCase(), brandLabel(app)),
    ''
  ]
  const footer = dashboardFooter(app, f, page)
  const space = Math.max(0, app.height - header.length - footer.length)
  const body = typeof page.body === 'function' ? page.body(space) : page.body

  return f.render([
    ...header,
    ...body.slice(0, space),
    ...Array(Math.max(0, space - body.length)).fill(''),
    ...footer
  ])
}

export function brandLabel(app: Dashboard) {
  return ['QV.AC', app.options.version].filter(Boolean).join(' ')
}

function dashboardFooter(
  app: Dashboard,
  f: Frame,
  { nav = true, hints = app.navHints(), aside = [] }: Partial<Page>
) {
  const width = f.inner
  const working = app.actionBusy ? paint('Working…', 'muted') : ''
  const right = width >= 60 ? keyHints(aside, Math.floor(width / 3)) : ''
  const keys = keyHints(hints, width - app.measure(right) - 1)
  const footer = nav
    ? [
        paint('─'.repeat(width), 'line'),
        ...(app.chat ? composerLine(app, width) : []),
        f.pair(app.tabs(), [working || paint(app.chat?.tabHint() || '', 'muted'), '']),
        keys
      ]
    : [paint('─'.repeat(width), 'line'), working || f.two(keys, right)]
  footer.unshift(...app.updateLines(width))

  const problem = app.error || (app.ready ? '' : app.status)
  if (problem) {
    footer.unshift(...paragraph(problem, width, 'red').slice(0, 3))
  }

  return footer
}

// the way into the chat beside the pages, and the rule under it
function composerLine(app: Dashboard, width: number) {
  return [
    strong('❯ ', 'teal') +
      paint(`Ask ${app.agent?.name || 'QV.AC'} anything`, 'text') +
      paint('  ·  enter to chat  ·  / for commands', 'muted'),
    paint('─'.repeat(width), 'line')
  ]
}

function blankPage(): Page {
  return { body: [] }
}

function startingPage(app: Dashboard, f: Frame): Page {
  return {
    body: [
      '',
      f.center(paint('Your most powerful device. Everywhere.', 'teal')),
      '',
      f.center(app.status)
    ]
  }
}
