type Model = NonNullable<RpcResult<'listModels'>['models']>[number]
type Download = NonNullable<WatchFrame<'modelDownloadsWatch'>['downloads']>[number]
import type { RpcResult, WatchFrame, Frame } from '@qvac/cli-kit/tui'
import { wrap, qrLines, modelParts, modelKind, remainingText } from '@qvac/cli-kit/tui'
import { paint, plain, logo, bytes, highlight, strong, paragraph } from '@qvac/cli-kit/brand'
import type { ProductApp } from '../app.js'
import type { Page, PageView } from '../dashboard/frame.js'
import { percentOf } from '../dashboard/pages.js'

export const FORMS = ['name', 'device-name', 'join']
// First-run setup keeps Esc as "back a step"; the invite page joins it until setup is done.
export const SETUP_PAGES = new Set([
  'welcome',
  'name',
  'device-name',
  'join',
  'join-confirm',
  'joining',
  'download'
])

const FORM_HINTS: [string, string][] = [
  ['enter', 'continue'],
  ['ctrl+u', 'clear'],
  ['esc', 'cancel'],
  ['ctrl+c', 'exit']
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

// Setting this device up, pairing it with another, and inviting devices and members.
export const PAGES: Record<string, PageView> = {
  welcome: welcomePage,
  name: formPage,
  'device-name': formPage,
  join: formPage,
  'join-confirm': joinConfirmPage,
  joining: joiningPage,
  download: downloadPage,
  invite: invitePage
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
