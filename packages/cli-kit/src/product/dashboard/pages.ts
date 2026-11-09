type Snapshot = Awaited<ReturnType<typeof snapshot>>
type Model = NonNullable<RpcResult<'listModels'>['models']>[number]
type Download = NonNullable<WatchFrame<'modelDownloadsWatch'>['downloads']>[number]
interface Hardware {
  cpu?: { name?: string; model?: string; memory?: number; usage?: { memoryTotal?: number } }
  gpu?: { devices?: { name?: string; unifiedMemory?: boolean }[] }
  hardware?: { model?: string }
}
import type { RpcResult, WatchFrame, Frame } from '../app-types.js'
import type { ChatLinks, Dashboard } from './app.js'
import type { snapshot } from '../data.js'
import { hex } from '../data.js'
import { wrap } from '../../lib/terminal/text.js'
import { modelParts, modelKind } from '../model-label.js'
import { palette, paint, bytes, count, strong } from '../theme.js'
import { paragraph } from '../ink.js'
import type { Page, PageView } from './frame.js'
import { NAV_HINTS } from './frame.js'

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

// The pages both products have: the workspace at a glance, this device, and its models.
export const PAGES: Record<string, PageView> = {
  overview: overviewPage,
  device: devicePage,
  models: modelsPage,
  catalog: modelsPage,
  remove: removePage,
  help: helpPage
}

function overviewPage(app: Dashboard, f: Frame): Page {
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
  if (app.chat?.chats.length) {
    body.push('', '', f.rule('RECENT CONVERSATIONS', 'ctrl+b all'), '', ...recentChats(app.chat))
  }

  return { body }
}

function metrics(app: Dashboard, f: Frame) {
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

function recentChats(links: ChatLinks) {
  return links.chats.slice(0, 3).map((chat) => {
    const current = chat.id === links.chatId
    return (
      paint(current ? '▸ ' : '  ', 'teal') +
      paint(chat.title || 'Untitled', current ? 'text' : 'muted')
    )
  })
}

function devicePage(app: Dashboard, f: Frame): Page {
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
function hardwareLine(app: Dashboard, p: Snapshot) {
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

function modelsPage(app: Dashboard, f: Frame): Page {
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
  app: Dashboard,
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

function removePage(app: Dashboard, f: Frame): Page {
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

function helpPage(app: Dashboard): Page {
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

export function percentOf(used: number | undefined, total: number | undefined) {
  return total ? Math.min(100, Math.round((100 * (used || 0)) / total)) : 0
}

function memoryBar(
  width: number,
  { used, total }: { used: number | undefined; total: number | undefined }
) {
  const filled = Math.round((width * percentOf(used, total)) / 100)
  return paint('━'.repeat(filled), 'teal') + paint('─'.repeat(width - filled), 'line')
}
