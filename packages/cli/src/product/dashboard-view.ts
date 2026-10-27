import type { RpcResult, WatchFrame } from './app-types.js'
import type { snapshot } from './data.js'
type Snapshot = Awaited<ReturnType<typeof snapshot>>
type Model = NonNullable<RpcResult<'listModels'>['models']>[number]
type Download = NonNullable<WatchFrame<'modelDownloadsWatch'>['downloads']>[number]
interface Page {
  body: string[] | ((room: number) => string[])
  header?: string[]
  nav?: boolean
  hints?: string[][]
  aside?: string[][]
}
interface Hardware {
  cpu?: { name?: string; model?: string; memory?: number; usage?: { memoryTotal?: number } }
  gpu?: { devices?: { name?: string; unifiedMemory?: boolean }[] }
  hardware?: { model?: string }
}
import type { ProductApp } from './app.js'
import type { Frame } from './app-types.js'
import { palette, paint, plain, logo, bytes, count, highlight } from './theme.js'
import { hex } from './data.js'
import { wrap } from './text.js'
import { qrLines } from './qr.js'
import { strong, paragraph, keyHints } from './ink.js'
import { modelParts, modelKind } from './model-label.js'
import { remainingText } from './download-rate.js'

export const FORMS = ['name', 'device-name', 'join']

const NAV_HINTS: [string, string][] = [
  ['i', 'invite'],
  ['v', 'all devices'],
  ['w', 'workspace'],
  ['s', 'status'],
  ['q', 'quit']
]
const FORM_HINTS: [string, string][] = [
  ['enter', 'continue'],
  ['ctrl+u', 'clear'],
  ['esc', 'cancel'],
  ['ctrl+c', 'exit']
]
const MODEL_HINTS: [string, string][] = [
  ['a', 'add model'],
  ['x', 'remove'],
  ['↑↓', 'choose'],
  ['l', 'load/unload'],
  ['enter', 'chat with it'],
  ['i', 'invite'],
  ['s', 'status'],
  ['q', 'quit'],
  ['d', 'retry']
]
const PAIR_STEPS = 'On a computer: qvac invite. In the app: Settings → My Devices → Pair New Device'
const JOIN = 'JOIN YOUR DEVICE'
const CREATE = 'SET UP THIS DEVICE'

const FORM_COPY: Record<string, { step: string; label: string; title: string; hint: string }> = {
  name: {
    step: '01 / 03',
    label: CREATE,
    title: 'First, what should we call you?',
    hint: 'People see it when you share a workspace with them later.'
  },
  'device-name': {
    step: '02 / 03',
    label: CREATE,
    title: 'Give this device a name.',
    hint: 'A name you’ll recognize on every device. It starts as this machine’s own.'
  },
  join: {
    step: '01 / 04',
    label: JOIN,
    title: 'One link brings it all together.',
    hint: PAIR_STEPS
  }
}

const INVITE_COPY = {
  member: {
    label: 'INVITE A MEMBER',
    title: 'Make room for your team.',
    steps: ['Open QV.AC on their device', 'Join With Code'],
    note: 'They join with their own account.'
  },
  device: {
    label: 'INVITE A DEVICE',
    title: 'Make room for another device.',
    steps: [
      'On a computer: qvac → Join my other device, or qvac serve --device-join <link>',
      'On your phone: Settings → My Devices → Pair New Device → Join With Code'
    ],
    note: 'Your models stay on this machine.'
  }
}

const PAGES: Record<string, (app: ProductApp, f: Frame) => Page> = {
  overview: overviewPage,
  devices: devicesPage,
  workspaces: workspacesPage,
  device: devicePage,
  models: modelsPage,
  catalog: modelsPage,
  welcome: welcomePage,
  name: formPage,
  'device-name': formPage,
  join: formPage,
  'join-confirm': joinConfirmPage,
  joining: joiningPage,
  download: downloadPage,
  invite: invitePage,
  remove: removePage,
  status: statusPage,
  help: helpPage
}

export function dashboardView(app: ProductApp, f: Frame) {
  const render = app.ready ? PAGES[app.page] || blankPage : startingPage
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

export function brandLabel(app: ProductApp) {
  return ['QV.AC', app.options.version].filter(Boolean).join(' ')
}

// The onboarding header: brand and version on the left, step and page label on the right.
function setupHeader(
  app: ProductApp,
  f: Frame,
  { label, step = '', rule = true }: { label: string; rule?: boolean; step?: string }
) {
  const brand =
    strong('◈ QV.AC', 'teal') +
    (app.options.version ? paint(`  ${app.options.version}`, 'muted') : '')
  const right = paint(step ? `${step}  ${label}` : label, 'muted')
  const top = f.clip(right, Math.max(0, f.inner - app.measure(brand) - 1))

  return [f.two(brand, top), '', ...(rule ? [paint('─'.repeat(f.inner), 'line'), ''] : [])]
}

function dashboardFooter(
  app: ProductApp,
  f: Frame,
  { nav = true, hints = NAV_HINTS, aside = [] }: Partial<Page>
) {
  const width = f.inner
  const working = app.actionBusy ? paint('Working…', 'muted') : ''
  const right = width >= 60 ? keyHints(aside, Math.floor(width / 3)) : ''
  const keys = keyHints(hints, width - app.measure(right) - 1)
  const footer = nav
    ? [
        paint('─'.repeat(width), 'line'),
        strong('❯ ', 'teal') +
          paint(`Ask ${app.agent?.name || 'QV.AC'} anything`, 'text') +
          paint('  ·  enter to chat  ·  / for commands', 'muted'),
        paint('─'.repeat(width), 'line'),
        f.pair(app.tabs(), [working || paint(app.tabHint(), 'muted'), '']),
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

function blankPage(): Page {
  return { body: [] }
}

function startingPage(app: ProductApp, f: Frame): Page {
  return {
    body: [
      '',
      f.center(paint('Your most powerful device. Everywhere.', 'teal')),
      '',
      f.center(app.status)
    ]
  }
}

function overviewPage(app: ProductApp, f: Frame): Page {
  const p = app.product!
  const loaded = p.models.filter((m) => m.isLoaded).length
  const body = [
    '',
    f.center(strong(`Welcome${app.accountName ? `, ${app.accountName}` : ''}.`)),
    f.center(paint('Your workspace, at a glance.', 'muted')),
    '',
    '',
    ...metrics(app, f),
    '',
    '',
    f.rule('THIS DEVICE', app.deviceName()),
    '',
    f.two(paint('COMPUTE ON THIS DEVICE', 'muted'), paint('CHAT MODEL', 'muted')),
    f.two(
      paint(`${count(loaded, 'model')} loaded`, 'teal') +
        paint(`  ·  ${p.models.filter((m) => m.isCached).length} on disk`, 'muted'),
      paint(app.agent?.modelName || 'Not selected', 'purple')
    ),
    paint('Available to your paired devices and workspace', 'muted'),
    '',
    paint('2', 'teal') + '  Explore this device'
  ]
  if (app.chats.length) {
    body.push('', '', f.rule('RECENT CONVERSATIONS', 'ctrl+b all'), '', ...recentChats(app))
  }

  return { body }
}

function metrics(app: ProductApp, f: Frame) {
  const p = app.product!
  const { measure } = app
  const labels = ['DEVICES', 'PEOPLE', 'LOCAL MODELS', 'PROJECTS']

  return [
    metricRow(f, { values: labels, color: 'muted', measure }),
    metricRow(f, {
      values: [
        [p.workspaceDevices?.length ?? '—', 'teal'],
        [p.members?.length ?? '—', 'text'],
        [p.models.length, 'purple'],
        [p.projects?.length ?? '—', 'teal']
      ],
      measure
    })
  ]
}

function recentChats(app: ProductApp) {
  return app.chats.slice(0, 3).map((chat) => {
    const current = chat.id === app.chatId
    return (
      paint(current ? '▸ ' : '  ', 'teal') +
      paint(chat.title || 'Untitled', current ? 'text' : 'muted')
    )
  })
}

function devicesPage(app: ProductApp, f: Frame): Page {
  const p = app.product!
  const devices = p.workspaceDevices || p.devices || []

  return {
    body: [
      strong('Together, more capable.'),
      '',
      ...devices.flatMap((d) => [
        f.two(paint(d.name, 'teal'), pairing(app, d)),
        paint(
          `${d.platform || 'Platform unavailable'} · ${count((d.cachedModelNames || []).length, 'model')} on disk`,
          'muted'
        ),
        ''
      ])
    ]
  }
}

function pairing(app: ProductApp, device: NonNullable<Snapshot['devices']>[number]) {
  if (hex(device.id) === hex(app.originDeviceId)) return 'This device'
  return device.revoked ? 'Removed' : 'Paired'
}

function workspacesPage(app: ProductApp): Page {
  const workspaces = app.product!.meshes.filter((m) => m.workspace)

  return {
    body: [
      strong('Choose your workspace.'),
      '',
      ...workspaces.map((m, i) =>
        paint(
          `${i === app.selection ? '›' : ' '} ${m.name || hex(m.meshId).slice(0, 12)} · ${m.state}`,
          i === app.selection ? 'teal' : 'text'
        )
      )
    ],
    hints: [
      ['↑↓', 'choose'],
      ['enter', 'open'],
      ['esc', 'back']
    ]
  }
}

function devicePage(app: ProductApp, f: Frame): Page {
  const p = app.product!
  const used = p.memory?.usedBytes
  const total = p.memory?.capBytes
  const active = p.models.filter((m) => m.isLoaded || m.isLoading)
  const loading = active.filter((m) => m.isLoading).length
  const body = [
    f.two(strong(app.deviceName()), paint('THIS DEVICE', 'teal')),
    ...paragraph(hardwareLine(app, p), f.inner, 'muted'),
    '',
    f.two(
      paint('MODEL MEMORY IN USE', 'muted'),
      `${bytes(used)} / ${bytes(total)}` + paint(`  ${percentOf(used, total)}%`, 'muted')
    ),
    memoryBar(f.inner, { used, total }),
    '',
    f.rule(
      'Models on this device',
      `${count(active.length - loading, 'model')} loaded${loading ? ` · ${loading} loading` : ''}`
    ),
    '',
    ...active.flatMap((m) => [
      f.two('  ' + m.name, m.isLoading ? paint('◌ Loading', 'teal') : paint('● Ready', 'green')),
      paint(`  ${bytes(m.memoryBytes || m.actualSize)} · ${modelKind(m)}`, 'purple'),
      ''
    ])
  ]
  if (!active.length) {
    body.push(paint('  No models loaded. Press 3 to choose one.', 'muted'))
  }

  return { body, hints: [['v', 'all devices'], ...NAV_HINTS.filter(([k]) => k !== 'v')] }
}

// One line of hardware facts; an integrated GPU shares the CPU's name, so print it once.
function hardwareLine(app: ProductApp, p: Snapshot) {
  const device = p.devices?.find((d) => hex(d.id) === hex(app.originDeviceId))
  const hardware = p.hardware as Hardware | null | undefined
  const cpu = hardwareName(hardware)
  const gpus = (hardware?.gpu?.devices || []).filter((g) => g.name !== cpu)
  const unified = hardware?.gpu?.devices?.some((g) => g.unifiedMemory)
  const memory = bytes(hardware?.cpu?.memory || hardware?.cpu?.usage?.memoryTotal)

  return [
    cpu,
    ...gpus.map((g) => g.name),
    `${memory} ${unified ? 'unified memory' : 'memory'}`,
    device?.platform
  ]
    .filter(Boolean)
    .join(' · ')
}

function modelsPage(app: ProductApp, f: Frame): Page {
  const p = app.product!
  const catalog = app.page === 'catalog'
  const models = (catalog ? app.catalog : p.models) ?? []
  const onDisk = p.models.reduce((s, m) => s + (m.actualSize || 0), 0)

  const body = (room: number) => {
    const shown = Math.max(1, Math.floor((room - 3) / 3))
    const start = Math.max(0, Math.min(app.selection - shown + 1, models.length - shown))
    const position =
      models.length > shown ? paint(`${app.selection + 1} of ${models.length}`, 'muted') : ''
    const rows = [
      f.two(
        strong(catalog ? 'Find your next model.' : 'Big ideas. Local models.'),
        paint(`${bytes(onDisk)} on disk`, 'muted')
      ),
      f.two(paint('Ready for any device in your workspace.', 'muted'), position),
      ''
    ]
    for (const [offset, m] of models.slice(start, start + shown).entries()) {
      rows.push(...modelRows(app, f, { model: m, selected: start + offset === app.selection }))
    }

    if (!models.length) {
      rows.push(paint('No models here yet. Press a to browse the catalog.', 'muted'))
    }

    return rows
  }

  return { body, hints: MODEL_HINTS }
}

function modelRows(
  app: ProductApp,
  f: Frame,
  { model: m, selected }: { model: Model; selected: boolean }
) {
  const download = app.modelDownloads.get(m.name)
  const { base, quant, bits } = modelParts(m.name)
  const size = bytes(m.actualSize || m.expectedSize)
  const precision = [bits, quant].filter(Boolean).join(' · ')
  const lead = paint(selected ? '❯ ' : '  ', 'teal') + paint(base, selected ? 'teal' : 'text')
  const facts =
    f.inner >= 64
      ? paint(' '.repeat(Math.max(1, 24 - app.measure(base))) + size.padEnd(10), 'muted') +
        paint(precision, 'purple')
      : ''
  const chat = m.name === app.agent?.modelName ? paint('  ·  chat model', 'teal') : ''
  const detail = f.inner >= 64 ? modelKind(m) : [size, precision, modelKind(m)].join(' · ')

  return [f.two(lead + facts, modelState(m, download)), paint(`  ${detail}`, 'muted') + chat, '']
}

function modelState(model: Model, download: Download | undefined) {
  if (download && !['complete', 'completed'].includes(download.phase)) {
    const percent = download.total ? ` ${percentOf(download.downloaded, download.total)}%` : ''
    return paint(`${download.phase}${percent}`, 'teal')
  }

  if (model.isLoading) {
    return paint('◌ Loading', 'teal')
  }

  if (model.isLoaded) {
    return paint('● Loaded', 'green')
  }

  return paint(model.isCached ? '○ Available' : 'Download', 'muted')
}

function welcomePage(app: ProductApp, f: Frame): Page {
  const width = Math.min(f.inner, 52)
  const indent = ' '.repeat(Math.floor((f.inner - width) / 2))
  const option = (index: number, label: string, note: string) => {
    const on = app.choice === index
    const row = on
      ? highlight(` ${label}${' '.repeat(Math.max(1, width - label.length - 3))}→ `)
      : paint(` ${label}`, 'text')

    return [indent + row, ...wrap(note, width - 1).map((r) => indent + paint(` ${r}`, 'muted'))]
  }

  return {
    nav: false,
    header: setupHeader(app, f, { label: 'WELCOME', rule: false }),
    body: [
      '',
      ...logo.map((line) => f.center(paint(line, 'teal'))),
      '',
      f.center(strong('Your most powerful device. Everywhere.')),
      ...wrap('Bring this machine together with your other devices.', f.inner).map((r) =>
        f.center(paint(r, 'muted'))
      ),
      '',
      '',
      ...option(0, 'Join my other device', 'Use a device link from QV.AC on a device you have.'),
      '',
      ...option(
        1,
        'Just this device',
        'Set it up on its own. Pair devices and add workspaces any time.'
      )
    ],
    hints: [
      ['↑↓', 'choose'],
      ['enter', 'continue']
    ],
    aside: [['ctrl+c', 'exit']]
  }
}

// pairing names the device too, as its third of four steps
const PAIRING_COPY: Record<string, { step: string; label: string }> = {
  'device-name': { step: '03 / 04', label: JOIN }
}

function formPage(app: ProductApp, f: Frame): Page {
  const copy = { ...FORM_COPY[app.page]!, ...(app.joinValue && PAIRING_COPY[app.page]) }
  const room = Math.max(1, f.inner - 3)
  const value = [...app.form].slice(-room).join('')

  return {
    nav: false,
    header: setupHeader(app, f, copy),
    body: [
      ...wrap(copy.title, f.inner).map((r) => strong(r)),
      ...paragraph(copy.hint, f.inner, 'muted'),
      '',
      strong('❯ ', 'teal') + paint(value, 'text') + highlight(' '),
      '',
      ...paragraph('Paste or type, then press enter.', f.inner, 'muted')
    ],
    hints: FORM_HINTS
  }
}

function joinConfirmPage(app: ProductApp, f: Frame): Page {
  const preview = app.joinPreview!

  return {
    nav: false,
    header: setupHeader(app, f, { step: '02 / 04', label: JOIN }),
    body: [
      strong('Pair this device'),
      paint(`Invited by ${preview.inviterName || 'a QVAC user'}`, 'muted'),
      '',
      ...wrap(
        'This pairs this machine into the inviter’s account, sharing that account’s identity and data.',
        f.inner
      )
    ],
    hints: [
      ['enter', 'confirm'],
      ['esc', 'cancel']
    ]
  }
}

function joiningPage(app: ProductApp, f: Frame): Page {
  return {
    nav: false,
    header: setupHeader(app, f, { step: '04 / 04', label: JOIN }),
    body: [
      strong('Pairing with your device…'),
      paint('It finishes once your other device is reachable and lets this one in.', 'muted'),
      ...(app.error ? ['', paint(app.error, 'red')] : [])
    ],
    hints: [
      ['esc', 'cancel'],
      ['ctrl+c', 'exit']
    ]
  }
}

function downloadPage(app: ProductApp, f: Frame): Page {
  const name = app.agent?.modelName
  const download = app.modelDownloads.get(name || '')
  const model = app.product!.models.find((m) => m.name === name)
  const { base, quant, bits } = modelParts(name || '')
  const facts = [[bits, quant].filter(Boolean).join(' · '), model && modelKind(model)]

  return {
    nav: false,
    header: setupHeader(app, f, { step: '03 / 03', label: 'GETTING YOUR MODELS' }),
    body: [
      strong('Your models. Right here.'),
      paint('Intelligence, ready on every device.', 'muted'),
      '',
      name
        ? paint(base, 'purple') +
          paint(
            facts
              .filter(Boolean)
              .map((t) => `  ·  ${t}`)
              .join(''),
            'muted'
          )
        : paint('Choose a model after setup', 'muted'),
      '',
      progressBar(Math.min(56, f.inner - 5), downloadPercent(model, download)),
      paint(transferLine(app, { name, model, download }), 'muted'),
      '',
      ...paragraph('Stored on this device. Available to your whole workspace.', f.inner, 'muted')
    ],
    hints: [
      ['enter', 'continue'],
      ['d', 'download/retry'],
      ['esc', 'back'],
      ['ctrl+c', 'exit']
    ]
  }
}

// `0.8 / 1.3 GB   284 MB/s · a few seconds remaining`, sampled from successive updates.
function transferLine(
  app: ProductApp,
  {
    name,
    model,
    download
  }: { name: string | undefined; model: Model | undefined; download: Download | undefined }
) {
  if (model?.isCached) {
    return `${bytes(model.actualSize || model.expectedSize)} · Ready on disk`
  }

  if (!download?.total) {
    return download?.phase || 'Ready to download · press d'
  }

  app.downloadRate.sample(name || '', download.downloaded ?? 0)
  const speed = app.downloadRate.speed(name || '')
  const rate = speed ? `${bytes(Math.round(speed))}/s` : download.phase

  return `${share(download.downloaded ?? 0, download.total)}   ${rate} · ${remainingText(app.downloadRate.remaining(name || '', { downloaded: download.downloaded ?? 0, total: download.total }))}`
}

function share(part: number, total: number) {
  const unit = total >= 1e9 ? 1e9 : 1e6
  return `${(part / unit).toFixed(unit === 1e9 ? 1 : 0)} / ${bytes(total)}`
}

function downloadPercent(model: Model | undefined, download: Download | undefined) {
  if (model?.isCached) return 100
  return download?.total ? percentOf(download.downloaded, download.total) : 0
}

function progressBar(length: number, percent: number) {
  const filled = Math.round((Math.max(1, length) * percent) / 100)
  return (
    paint('━'.repeat(filled), 'teal') +
    paint('─'.repeat(Math.max(0, length - filled)), 'line') +
    paint(` ${percent}%`, 'teal')
  )
}

function invitePage(app: ProductApp, f: Frame): Page {
  const invite = app.invitation?.invite
  const copy = INVITE_COPY[app.invitation?.member ? 'member' : 'device']
  const header = setupHeader(app, f, { label: copy.label, rule: false })
  const qr = invite ? qrLines(invite, { color: !app.options.noColor }) : []
  const side = [
    strong(copy.title),
    '',
    ...copy.steps.flatMap((s, i) => paragraph(s, f.inner, i ? 'muted' : 'text')),
    '',
    paint('● Ready to pair', 'green'),
    ...paragraph(copy.note, f.inner, 'muted')
  ]
  const link = app.showQr
    ? []
    : [
        '',
        ...wrap(plain(invite || 'No invitation available'), f.inner).map((r) => paint(r, 'teal'))
      ]
  const qrWidth = qr.length ? app.measure(qr[0]!) : 0
  const room = app.height - header.length - 2 - link.length

  return {
    nav: false,
    header,
    body: [...inviteLayout(f, { qr, qrWidth, side, room }), ...link],
    hints: [
      ['enter', 'back to workspace'],
      ['ctrl+y', 'copy link'],
      ['q', 'link/QR'],
      ['m', 'member invite'],
      ['d', 'pair device']
    ],
    aside: [['esc', 'back']]
  }
}

// QR on the left with the text beside it when wide enough, stacked when narrow.
function inviteLayout(
  f: { inner: number },
  { qr, qrWidth, side, room }: { qr: string[]; qrWidth: number; side: string[]; room: number }
) {
  const gap = 4
  if (qr.length && qr.length <= room && qrWidth + gap + 34 <= f.inner) {
    return qr.map((row: string, i: number) => row + ' '.repeat(gap) + (side[i] || ''))
  }

  if (qr.length && qr.length + side.length + 1 <= room && qrWidth <= f.inner) {
    return [...qr, '', ...side]
  }

  return [
    ...side,
    '',
    paint(`QR needs ${qr.length + side.length + 8} terminal rows. Resize to show it.`, 'muted')
  ]
}

function removePage(app: ProductApp, f: Frame): Page {
  const users = app.removeUsers.map((a) => a.agentName).join(', ')

  return {
    nav: false,
    body: [
      '',
      '',
      paint(`Remove ${app.removeName}?`, 'red'),
      '',
      ...wrap(
        'This deletes the downloaded weights from this machine’s model cache. Other QVAC installs using the same cache are affected.',
        f.inner
      ),
      '',
      ...wrap(
        app.removeUsers.length
          ? `Used by ${users}. These agents will need to download it again.`
          : 'No agents reference this model.',
        f.inner
      )
    ],
    hints: [
      ['y', 'remove'],
      ['n', 'keep'],
      ['esc', 'back']
    ]
  }
}

function statusPage(app: ProductApp, f: Frame): Page {
  const status = {
    connection: app.meshStatus,
    stateDirectory: app.options.dataDir,
    memory: app.product!.memory
  }

  return {
    body: [strong('This device, right now.'), '', ...wrap(JSON.stringify(status, null, 2), f.inner)]
  }
}

function helpPage(app: ProductApp): Page {
  return { body: [strong('A few keys. Everything in reach.'), '', ...app.helpLines()] }
}

// Evenly spaced cells; each value is a label or a [value, colour] pair.
function metricRow(
  f: { inner: number },
  {
    values,
    color,
    measure
  }: {
    values: (string | number | [string | number, keyof typeof palette])[]
    color?: keyof typeof palette
    measure(text: string): number
  }
) {
  const cell = Math.floor(f.inner / values.length)

  return values
    .map((v) => {
      const [text, tone] = Array.isArray(v) ? [String(v[0]), v[1]] : [String(v), color]
      const gap = cell - measure(text)
      return paint(
        ' '.repeat(Math.max(0, Math.floor(gap / 2))) +
          text +
          ' '.repeat(Math.max(0, Math.ceil(gap / 2))),
        tone
      )
    })
    .join('')
}

function hardwareName(h: Hardware | null | undefined) {
  return h?.cpu?.name || h?.cpu?.model || h?.hardware?.model || 'Hardware details unavailable'
}

function percentOf(used: number | undefined, total: number | undefined) {
  return total ? Math.min(100, Math.round((100 * (used || 0)) / total)) : 0
}

function memoryBar(
  width: number,
  { used, total }: { used: number | undefined; total: number | undefined }
) {
  const filled = Math.round((width * percentOf(used, total)) / 100)
  return paint('━'.repeat(filled), 'teal') + paint('─'.repeat(width - filled), 'line')
}
