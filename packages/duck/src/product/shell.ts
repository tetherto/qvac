import type { Agent } from '@qvac/cli-kit/config'
import type { Capabilities } from '@qvac/core/client'
import type {
  Command,
  Connection,
  Frame,
  HostStatus,
  KeyMessage,
  MouseMessage,
  Picker,
  PickerItem,
  ProductOptions,
  Tui,
  UpdateBanner,
  WatchFrame
} from './app-types.js'
import { canvas, paint, plain, logo, strong, paragraph, bootLines } from '@qvac/cli-kit/brand'
import { snapshot, hex } from './data.js'
import * as session from './session.js'
import { selectionText, paintSelection, DownloadRate } from '@qvac/cli-kit/tui'
import { RECEIVERS } from './receive.js'

export const SPIN = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏']
// [page, its number key, label]: the pages every product has; a product with a chat adds that tab
export const TABS: [string, string, string][] = [
  ['overview', '1 ', 'Overview'],
  ['device', '2 ', 'Device'],
  ['models', '3 ', 'Models']
]

// The TUI shell both products share: Core connection, header, pickers, mouse and the message loop.
// A product adds its pages on top: what boots once connected, how keys route, what a page shows.
export abstract class Shell {
  tui: Tui
  measure: (text: string) => number
  suspend: (fn: () => unknown) => Command
  options: ProductOptions
  engine: Capabilities | null
  originDeviceId: Uint8Array | null
  meshId: string | null
  workspaceId: string | null
  agent: Agent | null
  meshStatus: WatchFrame<'meshStatusWatch'> | null
  modelDownloads: Map<string, NonNullable<WatchFrame<'modelDownloadsWatch'>['downloads']>[number]>
  downloadRate: DownloadRate
  product: Awaited<ReturnType<typeof snapshot>> | null
  hostStatus: HostStatus | null
  paste: string | null
  picker: Picker<unknown> | null
  panel: { title: string; lines: string[] } | null
  iterators: Record<string, AsyncIterator<unknown>>
  updateBanner: UpdateBanner | null
  drag: { from: { x: number; y: number }; to: { x: number; y: number } } | null
  reconnect: Connection | void | null
  frameRows: string[]
  bodyHeight = 0
  width: number
  height: number
  ready: boolean
  page: string
  error: string
  notice: string
  status: string
  actionBusy: boolean
  started: number
  spinning: boolean
  frame: number
  restarting: boolean

  constructor(tui: Tui, options: ProductOptions = {}) {
    this.tui = tui
    this.measure = tui.style.width
    this.suspend = tui.suspend || ((fn) => fn)
    this.options = options
    this.width = 80
    this.height = 24
    this.engine = options.engine || null
    this.originDeviceId = options.deviceId || null
    this.meshId = options.meshId || null
    this.workspaceId = null
    this.agent = options.agent || null
    this.meshStatus = null
    this.modelDownloads = new Map()
    this.downloadRate = new DownloadRate()
    this.product = null
    this.hostStatus = null
    this.ready = false
    this.page = options.startPage || 'overview'
    this.error = ''
    this.notice = ''
    this.status = 'Starting QV.AC…'
    this.actionBusy = false
    this.started = Date.now()
    this.paste = null
    this.picker = null
    this.panel = null
    this.spinning = false
    this.frame = 0
    this.iterators = {}
    this.updateBanner = options.updateBanner || null
    this.drag = null
    this.restarting = false
    this.reconnect = null
    this.frameRows = []
  }

  // lunte-disable-next-line qvac/no-init-method -- bare-tui's Program calls model.init() at startup
  init(): Command {
    if (this.engine) {
      return this.connected({})
    }

    const connect = async () => {
      try {
        return { type: 'connected', ...(await this.options.connect!()) }
      } catch (error) {
        return { type: 'boot-error', error }
      }
    }

    return this.tui.batch(connect, this.spin())
  }

  connected(conn: Partial<Connection>): Command {
    this.engine = conn.engine || this.engine!
    this.originDeviceId = conn.deviceId || this.originDeviceId
    this.status = 'Opening your workspace…'
    return this.tui.batch(
      this.refresh(),
      this.tui.tick(2500, () => ({ type: 'product.poll' })),
      this.watch('mesh-status', () => this.engine!.meshStatusWatch({})),
      this.watch('downloads', () => this.engine!.modelDownloadsWatch({})),
      this.boot(),
      this.spin()
    )
  }

  // what a product opens once Core is connected
  boot(): Command {
    return null
  }

  watch(name: string, open?: (() => AsyncIterable<unknown>) | null, tag?: number): Command {
    if (!this.iterators[name]) {
      this.iterators[name] = open!()[Symbol.asyncIterator]()
    }

    return session.follow(this.iterators[name], name, tag)
  }

  unwatch(name: string) {
    const it = this.iterators[name]
    delete this.iterators[name]
    it?.return?.().catch(noop) // already-ended streams reject on return
  }

  get busy() {
    return false
  }

  spin(): Command {
    if (this.spinning || (!this.busy && this.ready)) return null
    this.spinning = true
    return this.tui.tick(90, () => ({ type: 'spin' }))
  }

  effect(fn: () => unknown, type = 'product.done') {
    return async () => {
      try {
        return { type, value: await fn() }
      } catch (error) {
        return { type: 'product.error', error }
      }
    }
  }

  action(fn: () => unknown, type?: string): Command {
    this.actionBusy = true
    this.error = ''
    return this.effect(fn, type)
  }

  refresh(): Command {
    return async () => {
      try {
        return {
          type: 'product.snapshot',
          value: await snapshot(this.engine!, this.workspaceId)
        }
      } catch (error) {
        return { type: 'product.snapshot-error', error }
      }
    }
  }

  // Detach from the old Core first, so its closing streams and polls are not reported as failures.
  async restartCore() {
    this.restarting = true
    for (const name of Object.keys(this.iterators)) {
      this.unwatch(name)
    }

    this.notice = 'Restarting Core… this takes a few seconds'
    this.reconnect = await this.options.restartCore!()
  }

  restarted(conn: Connection): Command {
    for (const name of Object.keys(this.iterators)) {
      this.unwatch(name)
    }

    this.reconnect = null
    this.restarting = false
    this.error = ''
    this.engine = conn.engine
    this.notice = 'Core restarted · plugin changes applied'

    return this.connected(conn)
  }

  // what a product does with each snapshot; the first one ends the boot screen
  snapshotTaken(): Command {
    if (!this.ready) {
      this.ready = true
    }

    return null
  }

  choose<T>(
    title: string,
    {
      items,
      onPick,
      cursor = 0,
      filter = ''
    }: { items: PickerItem<T>[]; onPick(value: T): Command; cursor?: number; filter?: string }
  ): Command {
    this.picker = { title, items, cursor, filter, onPick: (value) => onPick(value as T) }
    this.panel = null
    return null
  }

  pickerItems() {
    const query = this.picker!.filter.toLowerCase()
    return this.picker!.items.filter((i) =>
      `${i.label} ${i.hint || ''}`.toLowerCase().includes(query)
    )
  }

  pickerKey(msg: KeyMessage): Command {
    const p = this.picker!
    const items = this.pickerItems()
    if (msg.name === 'escape') {
      this.picker = null
      return null
    }

    if (msg.is('up', 'down')) {
      p.cursor = items.length ? cycle(p.cursor, { step: arrow(msg), length: items.length }) : 0
      return null
    }

    if (msg.is('enter')) {
      const item = items[Math.min(p.cursor, items.length - 1)]
      this.picker = null
      return item ? p.onPick(item.value) : null
    }

    if (msg.is('backspace')) {
      p.filter = [...p.filter].slice(0, -1).join('')
    } else if (!msg.ctrl && !msg.meta && msg.sequence >= ' ') {
      p.filter += msg.sequence
    }

    p.cursor = 0

    return null
  }

  pickerLines(width: number, height: number) {
    const p = this.picker!
    const items = this.pickerItems()
    const room = Math.max(1, height - 4)
    const start = Math.max(0, Math.min(p.cursor - room + 1, items.length - room))
    const row = (item: PickerItem<unknown>, i: number) => {
      const on = start + i === p.cursor
      return this.justify(
        paint(on ? '▸ ' : '  ', 'teal') + selectable(item.label, { on }),
        paint(item.hint || '', 'muted'),
        width
      )
    }

    return [
      strong(p.title) + paint(p.filter ? `  ${p.filter}▏` : '  type to filter', 'muted'),
      '',
      ...items.slice(start, start + room).map(row),
      ...(items.length ? [] : [paint('  Nothing matches', 'muted')]),
      '',
      paint('↑↓ choose  enter open  esc close', 'muted')
    ]
  }

  showPage(page: string): Command {
    this.page = page
    return null
  }

  update(msg: { type: string }): [this, Command] {
    const banner = this.updateBanner
    if (
      banner &&
      (msg.type.startsWith('update.') ||
        (msg.type === 'spinner.tick' && (msg as { id?: unknown }).id === banner.spinner?.id) ||
        (msg.type === 'key' &&
          (msg as KeyMessage).is?.('ctrl+u') &&
          this.paste === null &&
          ['ready', 'error'].includes(banner.state)))
    ) {
      const [, cmd] = banner.update(msg)
      return [this, cmd]
    }

    if (msg.type === 'resize') {
      this.width = (msg as { type: string; width: number }).width
      this.height = (msg as { type: string; height: number }).height
      return [this, null]
    }

    if (msg.type === 'mouse') {
      return [this, this.mouse(msg as MouseMessage)]
    }

    if (msg.type !== 'key') {
      return [this, this.receive(msg)]
    }

    return [this, this.key(msg as KeyMessage)]
  }

  receive(msg: { type: string }): Command {
    const handle = RECEIVERS.get(msg.type)
    return handle ? handle(this, msg as never) : null
  }

  key(msg: KeyMessage): Command {
    if (msg.name === 'paste-start') {
      this.paste = ''
      return null
    }

    if (this.paste !== null) {
      return this.pasteKey(msg)
    }

    if (msg.is('ctrl+c')) {
      return this.quitKey()
    }

    return this.routeKey(msg)
  }

  // ctrl+c: what a product does before it quits
  quitKey(): Command {
    return this.tui.quit
  }

  // the keys past the ones every page shares
  routeKey(_msg: KeyMessage): Command {
    return null
  }

  pasteKey(msg: KeyMessage): Command {
    if (msg.name === 'paste-end') {
      const text = this.paste
      this.paste = null
      this.pasted(text!)
    } else if (msg.name === 'return' || msg.name === 'enter' || msg.name === 'linefeed') {
      this.paste += '\n'
    } else if (msg.name === 'tab') {
      this.paste += '  '
    } else if (!msg.ctrl && !msg.meta && msg.sequence >= ' ') {
      this.paste += msg.sequence
    }

    return null
  }

  // what a product does with pasted text
  pasted(_text: string): void {}

  assign(fields: Partial<this>): Command {
    Object.assign(this, fields)
    return null
  }

  deviceName() {
    const device = this.product?.devices?.find((d) => hex(d.id) === hex(this.originDeviceId))
    return device?.name || this.options.deviceName || 'This device'
  }

  statusText() {
    const state = this.meshStatus?.state
    const online = state === 'joined'
    const uptime = Math.floor((Date.now() - this.started) / 1000)

    return (
      paint(online ? '● Online' : state || 'Starting', online ? 'green' : 'muted') +
      paint(` · up ${uptime}s`, 'muted')
    )
  }

  workspaceName() {
    const p = this.product!
    return p?.workspace ? p.workspace.name || 'Workspace connecting…' : 'Personal'
  }

  brandLine(f: Frame) {
    return f.two(
      strong('QV.AC  ', 'teal') +
        strong(this.workspaceName()) +
        paint(' · ' + this.deviceName(), 'muted'),
      this.statusText()
    )
  }

  // Opens the transcript under the brand line, which already names workspace, device and status.
  banner(f: Frame) {
    if (f.inner < 72 || this.height < 26) {
      return []
    }

    return [
      ...logo.map((line, i) => f.two(i === 1 ? this.modelsText() : '', paint(line, 'teal'))),
      ''
    ]
  }

  header(f: Frame) {
    const workspace = this.workspaceName()
    if (f.inner < 72 || this.height < 26) {
      return [this.brandLine(f)]
    }

    return [
      f.two(paint('Workspace  ', 'muted') + strong(workspace), paint(logo[0], 'teal')),
      f.two(paint('Device     ', 'muted') + this.deviceName(), paint(logo[1], 'teal')),
      f.two(this.modelsText(), paint(logo[2], 'teal')),
      f.two(paint('Status     ', 'muted') + this.statusText(), paint(logo[3], 'teal'))
    ]
  }

  modelsText() {
    if (this.page === 'chat') {
      return paint('Model      ', 'muted') + paint(this.agent?.modelName || 'Choosing…', 'purple')
    }

    const models = this.product!.models

    return (
      paint('Models     ', 'muted') +
      paint(`${models.filter((m) => m.isCached).length} on disk`, 'teal') +
      ' · ' +
      paint(`${models.filter((m) => m.isLoaded).length} loaded`, 'green')
    )
  }

  // the product's tabs; pages keep Bruno's 1–3. The current one is marked ▸.
  tabs() {
    return this.tabLine(TABS)
  }

  tabLine(tabs: [string, string, string][]) {
    return tabs
      .map(([page, key, label]) =>
        page === this.page ? strong(`▸ ${key}${label}`, 'teal') : paint(`  ${key}${label}`, 'muted')
      )
      .join(' ')
  }

  updateLines(width: number) {
    if (!this.updateBanner) return []
    this.updateBanner.width = width
    const view = this.updateBanner.view()
    return view ? view.split('\n') : []
  }

  mouse(msg: MouseMessage): Command {
    if (msg.action === 'wheel') {
      return this.wheel(msg)
    }

    const at = { x: msg.x, y: msg.y }
    if (msg.action === 'press' && msg.button === 'left') {
      this.drag = { from: at, to: at }
    } else if (msg.action === 'motion' && this.drag) {
      this.drag.to = at
    } else if (msg.action === 'release' && this.drag) {
      return this.release()
    }

    return null
  }

  wheel(_msg: MouseMessage): Command {
    return null
  }

  release(): Command {
    const { from, to } = this.drag!
    this.drag = null
    if (from.x === to.x && from.y === to.y) {
      return null
    }

    const text = selectionText(this.frameRows, from, to)
    if (!text || !this.options.copyToClipboard) {
      return null
    }

    this.notice = `Copied ${text.length} characters`

    return this.effect(() => this.options.copyToClipboard!(text), 'chat.noop')
  }

  view() {
    const frame = this.compose()
    this.frameRows = frame.split('\n')
    if (!this.drag) {
      return frame
    }

    return paintSelection(this.frameRows, this.drag!.from, this.drag!.to).join('\n')
  }

  compose() {
    const f = canvas({
      width: this.width,
      height: this.height,
      measure: this.measure,
      color: !this.options.noColor,
      theme: this.options.theme || this.options.config?.tui?.theme
    })
    if (!this.product) {
      return f.render(
        bootLines(f, {
          height: this.height,
          status: paint(
            `${SPIN[this.frame % SPIN.length]} ${this.status}`,
            this.error ? 'red' : 'muted'
          )
        })
      )
    }

    return this.pageView(f)
  }

  // the page the product shows once the first snapshot is in
  abstract pageView(f: Frame): string

  fit(rows: string[], width: number) {
    return rows.flatMap((l) => (this.measure(l) > width ? paragraph(plain(l), width) : [l]))
  }

  justify(left: string, right: string, width: number) {
    return left + ' '.repeat(Math.max(1, width - this.measure(left) - this.measure(right))) + right
  }

  close() {
    for (const name of Object.keys(this.iterators)) {
      this.unwatch(name)
    }
  }
}

export function selectable(text: string, { on }: { on: boolean }) {
  return on ? strong(text, 'teal') : paint(text)
}

export function arrow(msg: KeyMessage) {
  return msg.is('up') ? -1 : 1
}

export function cycle(index: number, { step, length }: { step: number; length: number }) {
  return (index + step + length) % length
}

const PAGE_KEYS: Record<string, string> = { 1: 'overview', 2: 'device', 3: 'models' }

// Alt+1–3 from anywhere; plain 1–3 only once Esc has stepped out of the composer.
export function pageKey(msg: KeyMessage, { plain }: { plain: boolean }) {
  const page = PAGE_KEYS[msg.name]
  if (!page || msg.ctrl) {
    return null
  }

  return msg.meta || plain ? page : null
}

export function noop() {}
