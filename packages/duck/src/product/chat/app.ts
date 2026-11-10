import { type WorkbenchConfig, describeConfig } from '@qvac/cli-kit/config'
import type {
  ActiveScreen,
  Attachment,
  Command,
  Connection,
  Frame,
  KeyMessage,
  MouseMessage,
  ProductOptions,
  RpcResult,
  Tui
} from '../app-types.js'
import type { Screen, ScreenContext, ScreenPanel, ScreenRow } from '../screen.js'
import { wrap, Editor } from '@qvac/cli-kit/tui'
import { Dashboard } from '../dashboard/app.js'
import { SPIN, selectable, arrow, cycle, pageKey, noop } from '../shell.js'
import {
  accountMesh,
  chooseAgent,
  remember as rememberChat,
  upload,
  visibleChats,
  writable
} from '../session.js'
import { paint, plain, bytes, applyTheme, strong, paragraph } from '@qvac/cli-kit/brand'
import type { LoadedExtensions } from '../extensions.js'
import type { loadTemplates, loadContextFiles } from '../../lib/runtime/resources.js'
import type { Chunk, Turn } from '../transcript.js'
import type { ProductCommand } from '../commands.js'
import { turns, pendingApproval, activeRun } from '../transcript.js'
import { renderTurns } from '../chat-view.js'
import { match, parse, commands } from '../commands.js'
import { Extensions } from '../extensions.js'
import { rank, mention } from '../fuzzy.js'
import { expandTemplate } from '../templates.js'
import { toMarkdown, toHtml, lastAssistantText } from '../export.js'
import { contextPreamble } from '../../lib/runtime/resources.js'
import { RECEIVERS } from './receive.js'

const PALETTE_ROWS = 6
const TOGGLE_BOXES: Record<string, string> = { on: paint('◉ ', 'teal'), off: paint('○ ', 'muted') }
const THINKING_NOTES = { inherit: 'follows the app default', enabled: 'on', disabled: 'off' }
// A setting, so it never reads as the run's state.
const REASONING_LABELS: Record<string, string> = {
  enabled: ' · thinking on',
  disabled: ' · thinking off'
}

const APPROVAL_KEYS: Record<string, { approved: boolean; scope?: 'once' | 'always' }> = {
  y: { approved: true },
  a: { approved: true, scope: 'always' },
  n: { approved: false }
}
const CHAT_SHORTCUTS: [string[], (app: ChatApp) => Command][] = [
  [['ctrl+t'], (app) => app.assign({ thinking: !app.thinking })],
  [['ctrl+l'], (app) => app.openModels()],
  [['shift+tab'], (app) => app.setThinking('')],
  [['ctrl+x'], (app) => app.copyLast()],
  [['ctrl+f'], (app) => app.assign({ search: { query: '', at: 0 } })],
  [['ctrl+home'], (app) => app.assign({ scroll: Infinity })],
  [['ctrl+end'], (app) => app.assign({ scroll: 0 })],
  [['ctrl+b'], (app) => app.openChats()],
  [['ctrl+n'], (app) => app.openChat(null)],
  [['ctrl+o'], (app) => app.assign({ expand: !app.expand })],
  [['ctrl+p'], (app) => app.openPalette()],
  [['ctrl+v'], (app) => app.pasteFile()],
  [['pgup', 'pageup'], (app) => app.assign({ scroll: app.scroll + app.pageStep() })],
  [
    ['pgdown', 'pagedown'],
    (app) => app.assign({ scroll: Math.max(0, app.scroll - app.pageStep()) })
  ]
]
// Keys the composer and the chat page already answer; a plugin may not take them.
const COMPOSER_KEYS = [
  ...CHAT_SHORTCUTS.flatMap(([keys]) => keys),
  ...['ctrl+c', 'ctrl+d', 'ctrl+g', 'ctrl+u', 'alt+e', 'escape', 'enter', 'tab', 'backspace'],
  ...['up', 'down', 'left', 'right', 'home', 'end', 'delete', 'alt+enter', 'shift+enter'],
  ...['ctrl+a', 'ctrl+e', 'ctrl+j', 'ctrl+k', 'ctrl+w', 'ctrl+y', 'ctrl+z', 'ctrl+]', 'ctrl+-'],
  ...['ctrl+_', 'ctrl+left', 'ctrl+right', 'alt+left', 'alt+right', 'alt+b', 'alt+f', 'alt+d'],
  ...['alt+y', 'alt+backspace', 'alt+delete', 'alt+1', 'alt+2', 'alt+3']
]
const SCREEN_COMMANDS = [
  'skills',
  'tools',
  'permissions',
  'plugins',
  'agent',
  'usage',
  'knowledge',
  'activity'
]
const PAGE_COMMANDS = ['overview', 'device', 'models']
const COMMANDS: Map<string, (app: ChatApp, arg: string) => Command> = new Map<
  string,
  (app: ChatApp, arg: string) => Command
>([
  ['new', (app) => app.openChat(null)],
  ['chats', (app) => app.openChats()],
  ['resume', (app) => app.openChats()],
  ['name', (app, arg) => app.command(`/rename ${arg}`)],
  ['hotkeys', (app) => app.command('/help')],
  ['thinking', (app, arg) => app.setThinking(arg)],
  ...SCREEN_COMMANDS.map((name) => [name, (app: ChatApp) => app.openScreen(name)] as const),
  ['compact', (app) => app.compact()],
  ['fork', (app) => app.openFork()],
  ['copy', (app) => app.copyLast()],
  ['export', (app, arg) => app.exportChat(arg)],
  ['session', (app) => app.show('Session', app.sessionLines())],
  ['context', (app) => app.show('Project context', app.contextLines())],
  ['reload', (app) => app.reload()],
  ['model', (app, arg) => app.openModels(arg)],
  ['details', (app) => app.toggleDetails()],
  ['stop', (app) => app.stop()],
  ['quit', (app) => app.tui.quit],
  ['exit', (app) => app.tui.quit],
  ...PAGE_COMMANDS.map((name) => [name, (app: ChatApp) => app.showPage(name)] as const),
  ['invite', (app, arg: string) => app.showInvite({ member: arg === 'member' })],
  ['rename', (app, arg) => app.renameChat(arg)],
  ['attach', (app, arg) => app.attachPath(arg)],
  ['folders', (app, arg) => app.folders(arg)],
  ['config', (app) => app.show('Configuration', app.configLines())],
  ['help', (app) => app.show('Help', app.helpLines())]
])

// what the chat needs from the host beyond the shell: extensions, prompt templates, context files
export interface ChatOptions extends ProductOptions {
  extensions?: LoadedExtensions | undefined
  loadTemplates?: (() => ReturnType<typeof loadTemplates>) | undefined
  loadContext?: (() => ReturnType<typeof loadContextFiles>) | undefined
}

// The chat page on the shell: conversations, the composer, the agent screens and extensions.
export abstract class ChatApp extends Dashboard {
  declare options: ChatOptions
  chatId: string | null
  chats: NonNullable<RpcResult<'listChats'>['chats']>
  turns: Turn[]
  pending: ReturnType<typeof pendingApproval>
  run: ReturnType<typeof activeRun>
  editor: Editor
  screen: ActiveScreen | null
  screens: Record<string, Screen>
  queued: string | null
  files: string[] | null
  before: Map<string, string | null | undefined>
  templates: ReturnType<NonNullable<ChatOptions['loadTemplates']>>
  contextFiles: ReturnType<NonNullable<ChatOptions['loadContext']>>
  search: { query: string; at: number; count?: number } | null
  extensions: Extensions
  awaiting: boolean
  runStarted: number
  paletteAt: number
  scroll: number
  expand: boolean
  thinking: boolean
  chatTag: number
  composing: boolean
  lastEscape: number

  constructor(tui: Tui, options: ChatOptions = {}) {
    super(tui, options)
    this.chat = this
    this.page = options.startPage || 'chat'
    this.chatId = null
    this.chats = []
    this.turns = []
    this.pending = null
    this.run = null
    this.awaiting = false
    this.runStarted = 0
    this.editor = new Editor()
    this.paletteAt = 0
    this.scroll = 0
    this.expand = options.config?.tui?.['toolOutput'] === 'expanded'
    this.thinking = false
    this.screen = null
    this.screens = options.screens || {}
    this.chatTag = 0
    this.queued = null
    this.composing = true
    this.files = null
    this.before = new Map()
    this.templates = options.loadTemplates?.() || []
    this.contextFiles = options.loadContext?.() || []
    this.search = null
    this.lastEscape = 0
    this.extensions = this.loadExtensions(options.extensions)
    applyTheme(this.extensions.theme)
  }

  loadExtensions(loaded: LoadedExtensions | undefined) {
    return new Extensions(loaded, {
      builtins: new Set([
        ...commands.map((c) => c.name),
        ...COMMANDS.keys(),
        ...this.templates.map((t) => t.name)
      ]),
      reserved: new Set(COMPOSER_KEYS),
      post: (msg: unknown) => this.options.post?.(msg),
      read: () => ({ agent: this.agent!, chatId: this.chatId!, cwd: this.options.cwd })
    })
  }

  override boot(): Command {
    return this.bootChat()
  }

  bootChat(): Command {
    const { options } = this
    const engine = this.engine!
    return async () => {
      try {
        const meshId = this.meshId || (await accountMesh(engine))
        await writable(engine, meshId)
        const config = await engine.getConfig({})
        let agent =
          this.agent ||
          (await chooseAgent(engine, meshId, {
            deviceId: this.originDeviceId,
            remembered: config.activeAgentId,
            modelName: options.model
          }))
        if (options.model && agent.modelName !== options.model) {
          agent = await engine.updateAgent({
            meshId,
            agentId: agent.id,
            config: { modelName: options.model }
          })
        }

        const chats = visibleChats((await engine.listChats({ meshId })).chats)
        const chat = chats.find((c) => c.id === config.activeChatId) || chats[0]

        return { type: 'chat.ready', meshId, agent, chats, chatId: chat?.id ?? null }
      } catch (error) {
        return { type: 'boot-error', error }
      }
    }
  }

  openChat(chatId: string | null | undefined): Command {
    this.unwatch('chunks')
    this.chatTag++
    this.chatId = chatId ?? null
    this.turns = []
    this.pending = null
    this.run = null
    this.scroll = 0
    this.picker = null
    this.panel = null
    // selection memory is a convenience; a failed write keeps the chat open
    const remember = rememberChat(this.engine!, { agentId: this.agent?.id, chatId }).then(
      () => null,
      () => null
    )
    if (!chatId) {
      return () => remember
    }

    return this.tui.batch(
      () => remember,
      this.watch(
        'chunks',
        () => this.engine!.chunksWatch({ meshId: this.meshId!, chatId }),
        this.chatTag
      )
    )
  }

  setTranscript(chunks: Chunk[]): Command {
    this.turns = turns(chunks)
    this.pending = pendingApproval(this.turns)
    const target =
      this.pending?.detail.name === 'write_file' && this.pending!.detail.arguments?.['path']
    if (typeof target === 'string' && target && !this.before.has(target)) {
      this.before.set(target, this.options.readText?.(target))
    }

    const run = activeRun(this.turns)
    if (run && run.runId !== this.run?.runId) {
      this.runStarted = Date.now()
    }

    if (run) {
      this.awaiting = false
    }

    this.run = run

    return this.spin()
  }

  override get busy() {
    return this.awaiting || !!this.run
  }

  chatTitle(max = 48) {
    const title = this.chats.find((c) => c.id === this.chatId!)?.title || 'New conversation'
    return title.length > max ? title.slice(0, max - 1) + '…' : title
  }

  // Core's suggested next message, offered while the run it follows is still the latest turn.
  suggestion() {
    if (this.busy || this.pending || this.editor.value) {
      return null
    }

    const offered = this.chats.find((c) => c.id === this.chatId!)?.suggestion
    const last = this.turns.at(-1)

    return offered && last?.from === 'agent' && last.runId === offered.runId ? offered.text : null
  }

  // A completed @reference reaches the model as the plain path it names.
  resolveMentions(text: string) {
    const known = new Set(this.files || [])

    return text.replace(/(^|\s)@([^\s@]+)/g, (all, lead, file: string) =>
      known.has(file) ? `${lead}${file}` : all
    )
  }

  send(text: string) {
    if (!this.meshId || !this.agent) {
      this.queued = text
      this.editor.remember()
      this.notice = 'Queued · sends as soon as your workspace is ready'
      return null
    }

    text = this.resolveMentions(text)
    this.editor.remember()
    this.awaiting = true
    this.runStarted = Date.now()
    this.scroll = 0
    this.notice = ''
    const { chatId, meshId, agent } = this
    const context = chatId ? '' : contextPreamble(this.contextFiles)

    return this.tui.batch(this.spin(), async () => {
      try {
        const result = await this.engine!.sendMessage(
          chatId
            ? { meshId, chatId, text }
            : {
                meshId,
                agentId: agent.id,
                text: context + text,
                title: text.split('\n')[0]!.slice(0, 48)
              }
        )
        return { type: 'chat.sent', chatId: result.chatId, text }
      } catch (error) {
        return { type: 'chat.send-error', error, text }
      }
    })
  }

  stop() {
    if (!this.run?.runId) return null
    this.notice = 'Stopping…'
    const { meshId, chatId } = this
    const runId = this.run.runId

    return this.effect(
      () => this.engine!.stopRun({ meshId: meshId!, chatId: chatId!, runId }),
      'chat.noop'
    )
  }

  approve({ approved, scope = 'once' }: { approved: boolean; scope?: 'once' | 'always' }): Command {
    const pending = this.pending!
    this.pending = null
    return this.effect(
      () =>
        this.engine!.resolveApproval({
          meshId: this.meshId!,
          chunkId: pending.id!,
          approved,
          scope,
          agentId: pending.detail.agentId ?? null
        }),
      'chat.noop'
    )
  }

  useModel(name: string): Command {
    if (!this.agent) {
      this.notice = 'Still connecting to your workspace'
      return null
    }

    return this.effect(
      () =>
        this.engine!.updateAgent({
          meshId: this.meshId!,
          agentId: this.agent!.id,
          config: { modelName: name }
        }),
      'chat.agent'
    )
  }

  attach(file: Attachment): Command {
    const scope = {
      meshId: this.meshId!,
      chatId: this.chatId!,
      originDeviceId: this.originDeviceId
    }
    this.notice = `Attaching ${file.fileName}…`

    return this.effect(async () => {
      if (!scope.chatId) {
        scope.chatId = (
          await this.engine!.createChat({
            meshId: scope.meshId,
            agentId: this.agent!.id,
            config: { title: file.fileName }
          })
        ).id
      }

      await upload(this.engine!, scope, file)

      return { chatId: scope.chatId, fileName: file.fileName }
    }, 'chat.attached')
  }

  screenContext(): ScreenContext {
    return {
      engine: this.engine!,
      meshId: this.meshId!,
      chatId: this.chatId!,
      agent: this.agent!,
      deviceId: this.originDeviceId,
      options: {
        ...this.options,
        restartCore: this.options.restartCore && (() => this.restartCore())
      },
      refreshAgent: async () =>
        (this.agent = await this.engine!.getAgent({
          meshId: this.meshId!,
          agentId: this.agent!.id
        }))
    }
  }

  openScreen(name: string): Command {
    const def = this.screens[name]
    if (!def) {
      this.notice = `/${name} is not available in this build`
      return null
    }

    if (!this.agent) {
      this.notice = 'Still connecting to your workspace'
      return null
    }

    this.page = 'chat'
    this.picker = null
    this.panel = null
    this.screen = {
      name,
      def,
      rows: [],
      note: [],
      cursor: 0,
      busy: true,
      error: '',
      detail: null,
      prompt: null
    }

    return this.loadScreen()
  }

  loadScreen(): Command {
    const screen = this.screen!
    screen.busy = true
    return async () => {
      try {
        return {
          type: 'screen.loaded',
          screen,
          value: await screen.def.load(this.screenContext())
        }
      } catch (error) {
        return { type: 'screen.error', screen, error }
      }
    }
  }

  screenRun(fn: (ctx: ScreenContext) => unknown): Command {
    const screen = this.screen!
    screen.busy = true
    screen.error = ''
    return async () => {
      try {
        const value = await fn(this.screenContext())
        if (this.agent) {
          // a stale agent only delays the header
          await this.screenContext().refreshAgent!().catch(noop)
        }

        return { type: 'screen.done', screen, value }
      } catch (error) {
        return { type: 'screen.error', screen, error }
      }
    }
  }

  override async restartCore() {
    this.chatTag++
    await super.restartCore()
  }

  override restarted(conn: Connection): Command {
    this.run = null
    this.awaiting = false
    return super.restarted(conn)
  }

  screenResult(value: ScreenPanel | void): Command {
    if (this.reconnect) {
      return this.tui.batch(this.restarted(this.reconnect), this.loadScreen())
    }

    if (value?.prompt) {
      this.screen!.prompt = { value: '', ...value.prompt } as NonNullable<ActiveScreen['prompt']>
    } else if (value?.lines) {
      this.screen!.detail = value as NonNullable<ActiveScreen['detail']>
    }

    this.screen!.busy = false

    return this.loadScreen()
  }

  screenKey(msg: KeyMessage): Command {
    const s = this.screen!
    if (s.prompt) {
      return this.promptKey(msg)
    }

    if (s.detail) {
      if (msg.name === 'escape' || msg.is('enter', 'q')) {
        s.detail = null
      }

      return null
    }

    if (msg.name === 'escape' || msg.is('q')) {
      this.screen = null
      return null
    }

    return s.busy ? null : this.screenRowKey(msg)
  }

  promptKey(msg: KeyMessage): Command {
    const s = this.screen!
    const p = s.prompt!
    if (msg.name === 'escape') {
      s.prompt = null
    } else if (msg.is('enter')) {
      const value = p.value
      s.prompt = null
      return this.screenRun(() => p.submit(value))
    } else if (msg.is('backspace')) {
      p.value = [...p.value].slice(0, -1).join('')
    } else if (msg.is('ctrl+u')) {
      p.value = ''
    } else if (!msg.ctrl && !msg.meta && msg.sequence >= ' ') {
      p.value += msg.sequence
    }

    return null
  }

  screenRowKey(msg: KeyMessage): Command {
    const s = this.screen!
    const row = s.rows[s.cursor]
    const toggle = row?.state && s.def.toggle
    if (msg.is('up', 'down') && s.rows.length) {
      s.cursor = (s.cursor + (msg.is('up') ? -1 : 1) + s.rows.length) % s.rows.length
      return null
    }

    if (msg.is('space') || msg.sequence === ' ') {
      return toggle ? this.screenRun((ctx) => s.def.toggle!(ctx, row!)) : null
    }

    if (msg.is('enter') && row) {
      if (s.def.open) {
        return this.screenRun((ctx) => s.def.open!(ctx, row))
      }

      return toggle ? this.screenRun((ctx) => s.def.toggle!(ctx, row!)) : null
    }

    const action = s.def.actions?.find((a) => msg.sequence === a.key && !msg.ctrl && !msg.meta)
    if (action) {
      return this.screenRun((ctx) => action.run(ctx))
    }

    return null
  }

  screenLines(width: number, height: number) {
    const s = this.screen!
    const head =
      strong(s.def.title) + (s.busy ? paint(`  ${SPIN[this.frame % SPIN.length]}`, 'teal') : '')
    if (s.detail) {
      return [
        head + paint(`  ·  ${s.detail.title}`, 'muted'),
        '',
        ...this.fit(s.detail.lines, width),
        '',
        paint('esc back', 'muted')
      ]
    }

    const out = [
      head,
      ...(s.error ? paragraph(s.error, width, 'red') : []),
      ...s.note.flatMap((n) => paragraph(plain(n), width, 'muted')),
      ''
    ]
    const room = Math.max(1, height - out.length - 3)
    const start = Math.max(0, Math.min(s.cursor - room + 1, s.rows.length - room))
    for (const [i, row] of s.rows.slice(start, start + room).entries()) {
      out.push(this.screenRow(row, { on: start + i === s.cursor, width }))
    }

    if (!s.rows.length && !s.busy) {
      out.push(paint('  Nothing here yet', 'muted'))
    }

    return [...out, '', ...this.screenFooter()]
  }

  screenRow(row: ScreenRow, { on, width }: { on: boolean; width: number }) {
    const box = TOGGLE_BOXES[row.state || ''] || '  '
    const badge = row.badge ? paint(row.badge.text, row.badge.color || 'muted') : ''
    const label = paint(on ? '▸ ' : '  ', 'teal') + box + selectable(row.label, { on })
    const room = Math.max(0, width - this.measure(label) - this.measure(badge) - 2)
    const detail = row.detail ? paint('  ' + plain(row.detail), 'muted') : ''
    const clipped =
      this.measure(detail) > room
        ? paint('  ' + plain(row.detail).slice(0, Math.max(0, room - 3)) + '…', 'muted')
        : detail

    return this.justify(label + clipped, badge, width)
  }

  screenFooter() {
    const { prompt, def } = this.screen!
    if (prompt) {
      const value = prompt.secret ? '•'.repeat([...prompt.value].length) : prompt.value
      return [
        strong(`${prompt.label} `) + paint(value, 'teal') + '▏',
        paint('enter save  esc cancel', 'muted')
      ]
    }

    const actions = (def.actions || []).map((a) => `${a.key} ${a.label}`)
    const keys = def.hint || ['↑↓ choose  space toggle  enter open', ...actions].join('  ')

    return [paint(`${keys}  esc back`, 'muted')]
  }

  templateCommands() {
    return this.templates.map((t) => ({
      name: t.name,
      desc: `${t.description || 'Prompt template'} · ${t.source}`,
      args: t.argumentHint,
      template: true
    }))
  }

  extraCommands() {
    return [...this.templateCommands(), ...this.extensions.entries()]
  }

  // metrics cross the mesh as json, so only a positive window with a count in it is a reading
  lastUsage() {
    const metrics = this.turns.findLast(
      (t): t is Extract<Turn, { from: 'agent' }> =>
        t.from === 'agent' && (t.run?.metrics?.ctxSize ?? 0) > 0
    )?.run?.metrics
    return metrics
      ? {
          window: metrics.ctxSize!,
          used: Math.max(0, Number(metrics.totalTokens) || 0),
          speed: metrics.tokensPerSecond
        }
      : null
  }

  setThinking(arg: string): Command {
    const current = this.agent?.reasoning || 'inherit'
    const next =
      (
        { on: 'enabled', off: 'disabled', default: 'inherit' } as Record<
          string,
          'enabled' | 'disabled' | 'inherit'
        >
      )[arg] || (current === 'enabled' ? 'disabled' : 'enabled')

    return this.effect(async () => {
      const agent = await this.engine!.updateAgent({
        meshId: this.meshId!,
        agentId: this.agent!.id,
        config: { reasoning: next }
      })
      return {
        ...agent,
        note: `Thinking ${THINKING_NOTES[next]}`
      }
    }, 'chat.agent')
  }

  compact(): Command {
    if (!this.chatId) {
      this.notice = 'Nothing to compact yet'
      return null
    }

    this.notice = 'Summarising earlier turns…'

    return this.effect(async () => {
      const { compacted, foldedTurns, reason } = await this.engine!.compactChat({
        meshId: this.meshId!,
        chatId: this.chatId!
      })
      return compacted
        ? `Compacted ${foldedTurns} earlier turns`
        : `Not compacted: ${reason || 'nothing to fold yet'}`
    }, 'chat.notice')
  }

  openFork(): Command {
    const points: { text: string; runId: string }[] = []
    this.turns.forEach((turn, i: number) => {
      const next = this.turns.slice(i + 1).find((t) => t.from === 'agent')
      if (turn.from === 'user' && next?.runId) {
        points.push({ text: turn.text, runId: next.runId })
      }
    })
    if (!this.chatId) {
      this.notice = 'Nothing to branch from yet'
      return null
    }

    const whole = { label: 'Whole conversation', hint: 'copy it as it is', value: null }
    const messages = points.reverse().map((p) => ({
      label: p.text.split('\n')[0]!.slice(0, 80),
      hint: 'edit and resend from here',
      value: p
    }))

    return this.choose('Branch into a new conversation', {
      items: [whole, ...messages],
      onPick: (p) =>
        p === null
          ? this.clone()
          : this.effect(async () => {
              const chat = await this.engine!.forkChat({
                meshId: this.meshId!,
                chatId: this.chatId!,
                runId: p.runId,
                exclusive: true
              })
              return {
                chatId: chat.id || (chat as typeof chat & { chatId?: string }).chatId,
                draft: p.text
              }
            }, 'chat.forked')
    })
  }

  clone(): Command {
    if (!this.chatId) return null
    return this.effect(async () => {
      const chat = await this.engine!.forkChat({
        meshId: this.meshId!,
        chatId: this.chatId!,
        config: { title: `${this.chatTitle(60)} (copy)` }
      })
      return { chatId: chat.id || (chat as typeof chat & { chatId?: string }).chatId, draft: '' }
    }, 'chat.forked')
  }

  copyLast(): Command {
    const text = lastAssistantText(this.turns)
    if (!text) {
      this.notice = 'No answer to copy yet'
      return null
    }

    this.notice = `Copied the last answer · ${text.length} characters`

    return this.effect(() => this.options.copyToClipboard?.(text), 'chat.noop')
  }

  exportChat(target: string) {
    if (!this.turns.length || !this.options.writeFile) {
      this.notice = this.turns.length ? 'Export is not available here' : 'Nothing to export yet'
      return null
    }

    const opts = {
      title: this.chatTitle(80),
      model: this.agent?.modelName,
      agentName: this.agent?.name,
      date: new Date()
    }
    const markdown = /\.md$/i.test(target)
    const name =
      target ||
      `qvac-${
        this.chatTitle(40)
          .replace(/[^\w.-]+/g, '-')
          .replace(/^-|-$/g, '')
          .toLowerCase() || 'chat'
      }.html`

    return this.effect(
      async () =>
        `Saved ${await this.options.writeFile!(name, markdown ? toMarkdown(this.turns, opts) : toHtml(this.turns, opts))}`,
      'chat.notice'
    )
  }

  runShell(text: string) {
    const quiet = text.startsWith('!!')
    const cmd = text.slice(quiet ? 2 : 1).trim()
    this.editor.remember()
    if (!cmd || !this.options.runShell) {
      this.notice = cmd ? 'Shell commands are not available here' : 'Type a command after !'
      return null
    }

    this.notice = `$ ${cmd}`

    return async () => {
      const result = await this.options.runShell!(cmd).catch((error) => ({
        stdout: '',
        stderr: error.message,
        exitCode: 1
      }))
      return { type: 'chat.shell', cmd, quiet, result }
    }
  }

  sessionLines() {
    const usage = this.lastUsage()
    const row = (k: string, v: string) => paint(k.padEnd(14), 'muted') + v
    return [
      row('Title', this.chatTitle(80)),
      row('Chat id', this.chatId || 'not created yet'),
      row('Messages', String(this.turns.filter((t: { from: string }) => t.from === 'user').length)),
      row('Agent', `${this.agent?.name || '—'} · ${this.agent?.modelName || '—'}`),
      row(
        'Context',
        usage
          ? `${usage.used.toLocaleString()} of ${usage.window.toLocaleString()} tokens (${Math.round((100 * usage.used) / usage.window)}%)`
          : 'no completed run yet'
      ),
      row('Speed', usage?.speed ? `${usage.speed.toFixed(1)} tok/s` : '—'),
      row('Folder', this.options.cwd || '—'),
      row('Storage', this.options.dataDir || '~/.qvac/duck')
    ]
  }

  contextLines() {
    if (!this.contextFiles.length) {
      return [
        paint('No AGENTS.md or CLAUDE.md found from here up to the filesystem root.', 'muted'),
        '',
        'Add an AGENTS.md to your project, or ~/.qvac/AGENTS.md for every project, then /reload.'
      ]
    }

    return [
      paint('Added to the start of each new conversation:', 'muted'),
      '',
      ...this.contextFiles.map(
        (f) =>
          paint('● ', 'teal') +
          f.path +
          paint(`  ${f.content.length.toLocaleString()} chars`, 'muted')
      ),
      '',
      paint(
        `Prompt templates: ${this.templates.map((t: { name: string }) => '/' + t.name).join(' ') || 'none (add .md files to .qvac/prompts or ~/.qvac/prompts)'}`,
        'muted'
      )
    ]
  }

  openChats() {
    this.page = 'chat'
    return this.choose('Conversations', {
      items: [
        { label: 'New conversation', hint: 'ctrl+n', value: null },
        ...this.chats.map((c) => ({
          label: c.title || 'Untitled',
          hint: c.id === this.chatId ? 'current' : '',
          value: c.id
        }))
      ],
      onPick: (id) => this.openChat(id),
      cursor: Math.max(0, this.chats.findIndex((c) => c.id === this.chatId!) + 1)
    })
  }

  openModels(filter = '') {
    this.page = 'chat'
    const models = (this.product?.models || []).filter((m) =>
      ['llm', 'completion'].includes(m.taskType || m.type)
    )
    const all = { label: 'All models…', hint: 'download, load and remove', value: null }

    return this.choose('Chat model', {
      items: [
        ...models.map((m) => ({
          label: m.name,
          hint: `${bytes(m.actualSize || m.expectedSize)}${m.isLoaded ? ' · loaded' : ''}${m.name === this.agent?.modelName ? ' · current' : ''}`,
          value: m.name
        })),
        all
      ],
      onPick: (name: string | null) =>
        name === null ? this.showPage('models') : this.useModel(name),
      cursor: Math.max(
        0,
        models.findIndex((m) => m.name === this.agent?.modelName)
      ),
      filter
    })
  }

  show(title: string, body: string[]): Command {
    this.panel = { title, lines: body }
    this.picker = null
    this.page = 'chat'
    return null
  }

  command(text: string): Command {
    const { name, arg } = parse(text)
    this.editor.remember()
    this.notice = ''
    const run = COMMANDS.get(name)
    if (run) {
      return run(this, arg)
    }

    const extension = this.extensions.command(name, arg)
    if (extension) {
      return extension
    }

    const template = this.templates.find((t) => t.name === name)
    if (template) {
      return this.send(expandTemplate(template.body, arg))
    }

    this.notice = `Unknown command /${name} · type / to see what is available`

    return null
  }

  override showPage(page: string) {
    this.composing = true
    return super.showPage(page)
  }

  reload(): Command {
    this.templates = this.options.loadTemplates?.() || []
    this.contextFiles = this.options.loadContext?.() || []
    this.files = null
    this.notice = `Reloaded · ${this.templates.length} prompt templates · ${this.contextFiles.length} context files`
    return null
  }

  toggleDetails(): Command {
    this.expand = !this.expand
    this.notice = this.expand ? 'Showing thinking and tool output' : 'Tool output collapsed'
    return null
  }

  renameChat(title: string): Command {
    if (!title || !this.chatId) {
      this.notice = this.chatId ? 'Use /rename <title>' : 'Send a message first, then rename it'
      return null
    }

    return this.effect(
      () =>
        this.engine!.renameChat({
          meshId: this.meshId!,
          chatId: this.chatId!,
          config: { title }
        }),
      'chat.noop'
    )
  }

  attachPath(path: string): Command {
    if (!path) {
      this.notice = 'Use /attach <path>, or copy a file path and press ctrl+v'
      return null
    }

    try {
      return this.attach(this.options.resolveFileAttachment!(path))
    } catch (caught) {
      const error = caught instanceof Error ? caught : new Error(String(caught))
      this.notice = `Cannot attach ${path}: ${error.message}`
      return null
    }
  }

  folders(arg: string) {
    const m = arg.match(/^(read|write|remove) (.+)$/)
    if (arg && !m) {
      this.notice = 'Use /folders, or /folders read|write|remove <path>'
      return null
    }

    const agent = this.agent!

    return this.effect(async () => {
      const readKey = `fs.${agent.id}.roots`
      const writeKey = `fs.${agent.id}.writable`
      const [r, w] = await Promise.all([
        this.engine!.configGet({ key: readKey }),
        this.engine!.configGet({ key: writeKey })
      ])
      let roots = (r.value || []) as (string | { kind?: string; path: string })[]
      let writes = (w.value || []) as string[]
      if (m) {
        const folder = await this.options.resolveDirectory!(m[2]!)
        roots = roots.filter((p) => (typeof p === 'string' ? p : p.path) !== folder)
        writes = writes.filter((p) => p !== folder)
        if (m[1] !== 'remove') {
          roots.push({ kind: 'local', path: folder })
        }

        if (m[1] === 'write') {
          writes.push(folder)
        }

        await this.engine!.configSet({ key: readKey, value: roots })
        await this.engine!.configSet({ key: writeKey, value: writes })
      }

      return { roots, writes }
    }, 'chat.folders')
  }

  pluginLines() {
    const config: Partial<WorkbenchConfig> = this.options.config || {}
    const harness = config?.harness || {}
    const plugins = this.hostStatus?.plugins || []
    const targets = harness.delegation?.targets || []

    return [
      paint('Plugins', 'muted'),
      ...(plugins.length
        ? plugins.map(
            (p) =>
              paint(p.state === 'ready' ? '● ' : '✗ ', p.state === 'ready' ? 'green' : 'red') +
              strong(p.name) +
              paint(p.error ? ` · ${p.error}` : ` · ${p.state}`, 'muted')
          )
        : [paint('First-party harness defaults only', 'text')]),
      '',
      paint('Delegation', 'muted'),
      paint('● ', 'green') + strong('local') + paint(' · on-device sub-agents', 'muted'),
      ...targets.map(
        (t) =>
          paint('● ', 'purple') +
          strong(t.name) +
          paint(` · ${t.protocol} · ${t.login || 'isolated'} login`, 'muted')
      ),
      '',
      paint('Add plugins under harness.plugins in qvac.config.js, then restart.', 'muted')
    ]
  }

  configLines() {
    const config: Partial<WorkbenchConfig> = this.options.config || {}
    return [
      paint('File', 'muted'),
      this.options.configPath || 'Built-in defaults',
      '',
      paint('State', 'muted'),
      this.options.dataDir || '~/.qvac/duck',
      '',
      paint('Model', 'muted'),
      this.agent?.modelName || 'Not selected',
      '',
      paint('Network policy', 'muted'),
      config?.harness?.policy?.network?.mode || 'default',
      '',
      paint('Every value, and where it comes from', 'muted'),
      ...describeConfig(config, this.options.sources),
      '',
      paint('Edit qvac.config.js / .ts / .json and restart to apply.', 'muted')
    ]
  }

  override helpLines() {
    const key = (k: string, d: string) => paint(k.padEnd(14), 'teal') + d
    return [
      paint('Chat', 'muted'),
      key('enter', 'send · alt+enter newline'),
      key('/', 'commands'),
      key('tab', 'use the suggested next message · complete a command or @file'),
      key('esc', 'stop the run, close a panel, or back to the dashboard'),
      key('ctrl+b', 'conversations · ctrl+n new'),
      key('ctrl+o', 'expand tool output · ctrl+t thinking'),
      key('ctrl+l', 'choose model · shift+tab thinking on/off'),
      key('ctrl+f', 'search the conversation'),
      key('ctrl+x', 'copy the last answer'),
      key('alt+e', 'edit the draft in $EDITOR'),
      key('esc esc', 'branch from an earlier message'),
      key('@', 'reference a project file'),
      key('!cmd', 'run a shell command and send its output · !!cmd keeps it local'),
      key('ctrl+d', 'exit when the composer is empty'),
      key('ctrl+v', 'attach the file whose path is on the clipboard'),
      key('pgup / pgdn', 'scroll · or the mouse wheel'),
      key('drag', "select and copy · shift+drag for the terminal's own selection"),
      key('y / a / n', 'approve once · always · deny'),
      '',
      paint('Dashboard', 'muted'),
      key('enter or c', 'chat'),
      key('1 2 3', 'overview · device · models'),
      key('i', 'invite'),
      key('ctrl+g', 'switch between chat and dashboard'),
      '',
      paint('Commands', 'muted'),
      ...match('/').map((c) => key(`/${c.name}`, c.desc)),
      ...this.extensionHelpLines(key)
    ]
  }

  extensionHelpLines(key: (name: string, description: string) => string) {
    const commands = this.extensions.entries()
    const keys = this.extensions.bindings()
    if (!commands.length && !keys.length) {
      return []
    }

    return [
      '',
      paint('Extensions', 'muted'),
      ...keys.map((k) => key(k.chord, k.extension)),
      ...commands.map((c) => key(`/${c.name}`, c.desc))
    ]
  }

  override receive(msg: { type: string }): Command {
    const handle = RECEIVERS.get(msg.type)
    return handle ? handle(this, msg as never) : super.receive(msg)
  }

  override quitKey(): Command {
    if (this.page === 'chat' && this.editor.value) {
      this.editor.reset()
      return null
    }

    return super.quitKey()
  }

  override routeKey(msg: KeyMessage): Command {
    if (this.page === 'chat') {
      return this.chatKey(msg)
    }

    return super.routeKey(msg)
  }

  override pasted(text: string): void {
    if (this.page !== 'chat' || this.pending) {
      return super.pasted(text)
    }

    if (this.picker) {
      this.picker!.filter += plain(text).replace(/\s+/g, ' ')
    } else {
      this.editor.paste(text)
    }
  }

  mentionAt() {
    if (!this.options.listFiles) return null
    return mention(this.editor.value, this.editor.cursor)
  }

  fileMatches(query: string) {
    this.files ??= this.options.listFiles!()
    return rank(query, this.files, 50)
  }

  chatKey(msg: KeyMessage): Command {
    const jump = pageKey(msg, { plain: !this.composing })
    if (jump) {
      return this.showPage(jump)
    }

    if (msg.sequence === '/' && !msg.ctrl && !msg.meta && this.overlayOpen()) {
      this.screen = null
      this.picker = null
      this.panel = null
      this.composing = true
      return this.openPalette()
    }

    if (!this.composing && msg.name !== 'escape') {
      this.composing = true
    }

    if (this.screen) {
      return this.screenKey(msg)
    }

    if (this.picker) {
      return this.pickerKey(msg)
    }

    if (this.pending) {
      return this.approvalKey(msg)
    }

    if (this.search) {
      return this.searchKey(msg)
    }

    if (msg.name === 'escape') {
      return this.escapeKey()
    }

    if (msg.is('ctrl+d') && !this.editor.value) {
      return this.tui.quit
    }

    if (msg.is('alt+e') && this.options.editExternal) {
      return this.editExternally()
    }

    const shortcut = CHAT_SHORTCUTS.find(([keys]) => msg.is(...keys))
    if (shortcut) {
      return shortcut[1](this)
    }

    return this.extensions.key(msg) || this.composerKey(msg)
  }

  pageStep() {
    return Math.max(1, this.bodyHeight - 2)
  }

  openPalette(): Command {
    this.editor.set('/')
    this.paletteAt = 0
    return null
  }

  approvalKey(msg: { is: (arg0: string) => unknown; name: string }) {
    const answer = Object.keys(APPROVAL_KEYS).find((key) => msg.is(key))
    if (answer) {
      return this.approve(APPROVAL_KEYS[answer]!)
    }

    return msg.name === 'escape' ? this.stop() : null
  }

  escapeKey(): Command {
    const double = Date.now() - this.lastEscape < 500
    this.lastEscape = Date.now()
    if (this.panel) {
      this.panel = null
    } else if (this.editor.value.startsWith('/')) {
      this.editor.reset()
    } else if (this.busy) {
      return this.stop()
    } else if (double && !this.editor.value && this.turns.length) {
      return this.openFork()
    } else if (this.notice) {
      this.notice = ''
    } else if (!this.editor.value) {
      this.composing = false
    }

    return null
  }

  // A screen asking for a value keeps its "/" (paths have them); anything else gives way to commands.
  overlayOpen() {
    return !!(this.picker || this.panel || (this.screen && !this.screen.prompt))
  }

  editExternally(): Command {
    const draft = this.editor.expanded()
    return this.suspend(async () => {
      try {
        return { type: 'chat.edited', text: await this.options.editExternal!(draft) }
      } catch (error) {
        return { type: 'error', error } // an editor that never ran leaves the draft as it was
      }
    })
  }

  pasteFile(): Command {
    return async () => {
      try {
        const file = await this.options.resolvePastedFile?.()
        return file ? { type: 'chat.paste-file', file } : { type: 'chat.noop' }
      } catch {
        return { type: 'chat.noop' } // nothing usable on the clipboard
      }
    }
  }

  composerKey(msg: KeyMessage): Command {
    const at = this.mentionAt()
    if (at && this.mentionKey(msg, at)) {
      return null
    }

    const options = match(this.editor.value, this.extraCommands())
    if (options.length && msg.is('up', 'down')) {
      this.paletteAt = cycle(this.paletteAt, { step: arrow(msg), length: options.length })
      return null
    }

    if (options.length && msg.is('tab')) {
      this.editor.set(`/${options[Math.min(this.paletteAt, options.length - 1)]!.name} `)
      return null
    }

    const suggested = msg.is('tab') && this.suggestion()
    if (suggested) {
      this.editor.set(suggested)
      return null
    }

    if (msg.is('enter')) {
      return this.submit(options)
    }

    return this.typeKey(msg)
  }

  typeKey(msg: KeyMessage): Command {
    if (msg.is('up', 'down')) {
      if (!this.editor.key(msg)) {
        this.editor.recall(arrow(msg))
      }

      return null
    }

    if (msg.is('alt+enter', 'shift+enter', 'ctrl+j', 'linefeed')) {
      this.editor.insert('\n')
      return null
    }

    const before = this.editor.value
    this.editor.key(msg)
    if (this.editor.value !== before) {
      this.paletteAt = 0
    }

    return null
  }

  mentionKey(msg: KeyMessage, at: { start: number; query: string }): boolean {
    const files = this.fileMatches(at.query)
    if (!files.length) {
      return false
    }

    if (msg.is('up', 'down')) {
      this.paletteAt = cycle(this.paletteAt, { step: arrow(msg), length: files.length })
      return true
    }

    if (!msg.is('tab', 'enter')) {
      return false
    }

    const file = files[Math.min(this.paletteAt, files.length - 1)]
    const { value, cursor } = this.editor
    this.editor.value = value.slice(0, at.start) + `@${file} ` + value.slice(cursor)
    this.editor.cursor = at.start + file!.length + 2
    this.paletteAt = 0

    return true
  }

  submit(options: (ProductCommand & { template?: boolean })[]): Command {
    const text = this.editor.expanded()
    if (!text.trim()) {
      return null
    }

    if (text.startsWith('!')) {
      return this.runShell(text)
    }

    if (options.length && !text.includes(' ')) {
      return this.pickCommand(options[Math.min(this.paletteAt, options.length - 1)]!)
    }

    if (text.startsWith('/') && !text.startsWith('//')) {
      return this.command(text)
    }

    this.screen = null
    this.panel = null

    return this.send(text.startsWith('//') ? text.slice(1) : text)
  }

  pickCommand(chosen: ProductCommand & { file?: boolean; template?: boolean }): Command {
    if (chosen.args && !['model', 'folders', 'invite'].includes(chosen.name)) {
      this.editor.set(`/${chosen.name} `)
      return null
    }

    return this.command(`/${chosen.name}`)
  }

  searchKey(msg: KeyMessage): Command {
    const s = this.search!
    if (msg.name === 'escape') {
      this.search = null
    } else if (msg.is('enter', 'ctrl+g', 'down')) {
      s.at++
    } else if (msg.is('shift+enter', 'up')) {
      s.at = Math.max(0, s.at - 1)
    } else if (msg.is('backspace')) {
      s.query = [...s.query].slice(0, -1).join('')
      s.at = 0
    } else if (!msg.ctrl && !msg.meta && msg.sequence >= ' ') {
      s.query += msg.sequence
      s.at = 0
    }

    return null
  }

  tabHint() {
    if (this.page !== 'chat') return 'esc chat · alt+1–3'
    // esc stops a run, so it cannot also be the way to the pages
    if (this.busy) return 'alt+1–3 pages'
    return this.composing === false ? '1–3 pages · type to chat' : 'esc then 1–3 · alt+1–3'
  }

  override wheel(msg: MouseMessage): Command {
    if (this.page !== 'chat') {
      return super.wheel(msg)
    }

    const step = msg.button === 'wheelup' ? -1 : 1
    if (this.picker) {
      const n = this.pickerItems().length
      if (n) {
        this.picker!.cursor = (this.picker!.cursor + step + n) % n
      }
    } else if (!this.panel) {
      this.scroll = Math.max(0, this.scroll - step * 3 * (msg.alt ? 5 : 1))
    }

    return null
  }

  pageView(f: Frame) {
    return this.chatView(f)
  }

  chatView(f: Frame) {
    // One brand line stays pinned; the full header opens the transcript and scrolls away with it.
    const header = [this.brandLine(f), f.rule('CHAT', this.chatTitle(Math.floor(f.inner / 2)))]
    const footer = this.chatFooter(f)
    const height = Math.max(1, this.height - header.length - footer.length - 1)
    this.bodyHeight = height
    const body = this.chatBody(f, height).slice(0, height)

    return f.render([
      ...header,
      '',
      ...body,
      ...Array(Math.max(0, height - body.length)).fill(''),
      ...footer
    ])
  }

  chatFooter(f: Frame) {
    const width = f.inner
    const rule = paint('─'.repeat(width), this.busy || this.pending ? 'teal' : 'line')
    const model = `  ${this.agent?.modelName || ''}${this.thinkingLabel()} · ${this.deviceName()}`
    const status = this.runState() + paint(model, 'muted')
    const meter = this.usageMeter()
    const hints = paint('/ commands  ctrl+b chats', 'muted')
    const core = meter
      ? [meter + '   ' + hints, meter, '']
      : [hints, paint('/ commands', 'muted'), '']
    const extra = this.extensions.footer()
    const tabs = this.tabs() + '   ' + paint(this.tabHint(), 'muted')
    const room = Math.max(0, width - this.measure(tabs) - 1)

    return [
      ...this.updateLines(width),
      ...(this.notice ? paragraph(this.notice, width, 'muted').slice(0, 2) : []),
      ...(this.error ? paragraph(this.error, width, 'red').slice(0, 2) : []),
      ...this.paletteLines(),
      rule,
      ...this.composerLines(width),
      rule,
      // plugin text only joins the full core hint, so it is the first thing to go when narrow
      f.pair(status, extra ? [paint(extra, 'muted') + '   ' + core[0], ...core] : core),
      f.pair(tabs, room >= 12 ? [paint(this.whereLabel(room), 'muted')] : [''])
    ]
  }

  commandOptions() {
    if (this.picker || this.pending) return []
    return match(this.editor.value, this.extraCommands())
  }

  paletteLines() {
    const mentioning = !this.picker && !this.pending && this.mentionAt()
    const options = mentioning
      ? this.fileMatches(mentioning.query).map((file) => ({ name: file, file: true }))
      : this.commandOptions()
    const at = Math.min(this.paletteAt, Math.max(0, options.length - 1))
    const start = Math.max(0, Math.min(at - PALETTE_ROWS + 1, options.length - PALETTE_ROWS))
    const nameWidth = Math.max(0, ...options.map((c) => c.name.length + 1)) + 2
    const rows = options
      .slice(start, start + PALETTE_ROWS)
      .map((option, i: number) => paletteRow(option, { on: start + i === at, nameWidth }))
    if (mentioning && !options.length) {
      rows.push(paint('  No matching files', 'muted'))
    }

    return rows
  }

  composerLines(width: number) {
    if (this.search) {
      return [
        strong('⌕ ', 'teal') +
          this.search!.query +
          '▏' +
          paint(`   ${this.searchStatus()} · enter next · esc close`, 'muted')
      ]
    }

    if (this.composing === false) {
      const rows = this.editor.value ? wrap(this.editor.value, width - 2).slice(0, 6) : ['']
      return rows.map(
        (r, i) => paint(i ? '  ' : '❯ ', 'muted') + paint(r || this.placeholder(), 'muted')
      )
    }

    if (!this.editor.value) {
      return [strong('❯ ', 'teal') + '▏' + paint(this.placeholder(), 'muted')]
    }

    return this.editor
      .rows(width - 2, Math.max(1, Math.min(6, this.height - 16)))
      .map((row: string, i) => strong(i ? '  ' : '❯ ', 'teal') + row)
  }

  searchStatus() {
    const { count, at, query } = this.search!
    if (count) {
      return `${(at % count) + 1}/${count}`
    }

    return query ? 'no matches' : 'search the conversation'
  }

  placeholder() {
    if (this.pending) return 'Answer the approval above · y / a / n'
    if (this.busy) return 'Steer it: it reads this at its next step · esc stops'
    const suggested = this.suggestion()
    if (suggested) {
      return `${suggested} · tab to use`
    }

    return `Ask ${this.agent?.name || 'QV.AC'} anything · / for commands`
  }

  // What the run is doing shows once, inline in the transcript; the footer keeps only the key.
  runState() {
    const spin = SPIN[this.frame % SPIN.length]
    // The composer already asks for y / a / n.
    if (this.pending) {
      return ''
    }

    if (this.busy) {
      return paint('esc stop', 'muted')
    }

    if (this.agent) {
      return paint('● Ready', 'green')
    }

    return paint(`${spin} ${this.status || 'Connecting'}`, 'muted')
  }

  chatBody(f: Frame, height: number) {
    if (this.screen) {
      return this.screenLines(f.inner, height)
    }

    if (this.picker) {
      return this.pickerLines(f.inner, height)
    }

    if (this.panel) {
      return [
        strong(this.panel.title),
        '',
        ...this.fit(this.panel.lines, f.inner),
        '',
        paint('esc close', 'muted')
      ]
    }

    if (!this.turns.length && !this.awaiting) {
      return this.emptyLines(f, height)
    }

    return this.transcriptLines(f, height)
  }

  transcriptLines(f: Frame, height: number) {
    const all = [...this.banner(f), ...this.renderedTurns(f.inner)]
    const hit = this.searchHit(all, height)
    this.scroll = Math.min(this.scroll, Math.max(0, all.length - height))
    const from = Math.max(0, all.length - height - this.scroll)
    const body = all.slice(from, from + height)
    if (hit >= from && hit < from + height) {
      body[hit - from] = '\x1b[7m' + plain(body[hit - from]) + '\x1b[27m'
    }

    if (this.scroll && !this.search) {
      body[body.length - 1] = paint(`↓ ${this.scroll} more lines · pgdn`, 'teal')
    }

    return body
  }

  renderedTurns(width: number) {
    const spin = SPIN[this.frame % SPIN.length]
    const all = renderTurns(this.turns, width, {
      agentName: this.agent?.name,
      expand: this.expand,
      thinking: this.thinking,
      spin,
      before: (file: unknown) =>
        typeof file === 'string' ? (this.before.get(file) ?? undefined) : undefined,
      cwd: this.options.cwd,
      elapsed: Date.now() - this.runStarted
    })
    if (this.awaiting && !this.run) {
      all.push(
        strong(`◆ ${this.agent?.name || 'QV.AC'}`, 'teal'),
        paint(`  ${spin} Sending…`, 'muted')
      )
    }

    return all
  }

  searchHit(all: string[], height: number) {
    if (!this.search?.query) return -1
    const query = this.search!.query.toLowerCase()
    const hits = all
      .map((l, i) => (plain(l).toLowerCase().includes(query) ? i : -1))
      .filter((i: number) => i >= 0)
    this.search!.count = hits.length
    if (!hits.length) {
      return -1
    }

    const hit = hits[hits.length - 1 - (this.search!.at % hits.length)]!
    this.scroll = Math.max(0, all.length - hit - Math.ceil(height / 2))

    return hit
  }

  thinkingLabel() {
    return REASONING_LABELS[this.agent?.reasoning || ''] || ''
  }

  // How full the model's context is: a bar that fills, then tokens used of the window.
  usageMeter() {
    const u = this.lastUsage()
    if (!u) {
      return ''
    }

    const pct = Math.min(100, Math.round((100 * u.used) / u.window))
    const filled = Math.round((pct / 100) * METER_CELLS)

    return (
      paint('context ', 'muted') +
      paint('━'.repeat(filled), pct > 70 ? usageColor(pct) : 'teal') +
      paint('━'.repeat(METER_CELLS - filled), 'line') +
      paint(` ${tokens(u.used)} of ${tokens(u.window)}`, usageColor(pct))
    )
  }

  whereLabel(max: number) {
    const home = this.options.home
    let where = this.options.cwd || ''
    if (home && where.startsWith(home)) {
      where = '~' + where.slice(home.length)
    }

    const branch = this.options.gitBranch?.()
    const text =
      where + (branch ? ` (${branch})` : '') + (this.contextFiles.length ? ' · AGENTS.md' : '')

    return text.length > max ? shortPath(text, max) : text
  }

  emptyLines(f: Frame, height: number) {
    const hint = (k: string, d: string) => paint(k.padEnd(9), 'teal') + paint(d.padEnd(24), 'muted')
    const block = [
      f.center(strong('What would you like to work on?')),
      '',
      f.center(
        paint(
          `${this.agent?.modelName || 'Your local model'} on ${this.deviceName()} · private by default`,
          'muted'
        )
      ),
      '',
      '',
      f.center(hint('/model', 'choose a model') + hint('ctrl+v', 'attach a file')),
      f.center(hint('/chats', 'past conversations') + hint('/plugins', 'tools and agents')),
      f.center(hint('/folders', 'grant project access') + hint('/help', 'everything else'))
    ]
    const top = this.banner(f)
    const pad = Math.max(0, Math.floor((height - top.length - block.length) / 2) - 1)

    return [...top, ...Array(pad).fill(''), ...block]
  }
}

function paletteRow(
  option: { name: string; desc?: string; args?: string; file?: boolean },
  { on, nameWidth }: { on: boolean; nameWidth: number }
) {
  if (option.file) {
    const slash = option.name.lastIndexOf('/') + 1
    return (
      paint(on ? '▸ @' : '  @', 'teal') +
      paint(option.name.slice(0, slash), 'muted') +
      selectable(option.name.slice(slash), { on })
    )
  }

  return (
    paint(on ? '▸ ' : '  ', 'teal') +
    selectable(`/${option.name}`.padEnd(nameWidth), { on }) +
    paint(option.desc + (option.args ? ` ${option.args}` : ''), 'muted')
  )
}

const METER_CELLS = 12

const tokens = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(n >= 10000 ? 0 : 1)}k` : String(n))

function usageColor(pct: number) {
  if (pct > 90) return 'red'
  return pct > 70 ? 'purple' : 'muted'
}

// `~/…/tail` of a path label that keeps as many trailing segments as fit in max cells.
function shortPath(text: string, max: number) {
  const parts = text.split('/')
  for (let i = 1; i < parts.length; i++) {
    const tail = `${parts[0]}/…/${parts.slice(i).join('/')}`
    if (tail.length <= max) {
      return tail
    }
  }

  return '…' + text.slice(text.length - max + 1)
}
