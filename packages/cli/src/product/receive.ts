import type { ProductApp } from './app.js'
import type {
  ActiveScreen,
  Attachment,
  Command,
  Connection,
  RpcResult,
  WatchFrame
} from './app-types.js'
import type { Agent } from '../lib/types.js'
import type { ScreenData, ScreenPanel } from './screen.js'
import type { LoadedExtensions } from './extensions.js'
import type { snapshot } from './data.js'
type Value<T> = { value: T }
type Failure = { error: Error }
import { applyTheme, paint } from './theme.js'
import * as session from './session.js'

const RECEIVERS = new Map<string, (app: ProductApp, msg: never) => Command>([
  ['connected', (app, msg: Connection) => app.connected(msg)],
  ['boot-error', bootFailed],
  ['spin', spun],
  ['chat.ready', chatReady],
  ['chunks', chunksArrived],
  ['chunks.end', chunksEnded],
  ['chats', chatsChanged],
  ['agents', agentsChanged],
  ['mesh-status', meshStatusChanged],
  ['downloads', downloadsChanged],
  ['chat.sent', sent],
  ['chat.send-error', sendFailed],
  ['chat.agent', agentUpdated],
  ['chat.notice', noticed],
  ['chat.forked', forked],
  ['chat.shell', shellFinished],
  ['chat.attached', attached],
  ['chat.folders', foldersListed],
  [
    'chat.paste-file',
    (app, msg: { file: Attachment | null }) => (msg.file ? app.attach(msg.file) : null)
  ],
  ['chat.edited', edited],
  ['chat.noop', () => null],
  ['screen.loaded', screenLoaded],
  [
    'screen.done',
    (app, msg: { screen: ActiveScreen; value: ScreenPanel | void }) =>
      msg.screen === app.screen ? app.screenResult(msg.value) : null
  ],
  ['screen.error', screenFailed],
  ['error', failed],
  ['product.snapshot', snapshotArrived],
  ['product.poll', polled],
  ['product.snapshot-error', snapshotFailed],
  ['product.error', actionFailed],
  ['product.done', actionDone],
  ['product.join-preview', joinPreviewed],
  ['product.created', workspaceCreated],
  ['product.invite', invited],
  ['product.catalog', catalogLoaded],
  ['product.finished', onboarded],
  ['product.paired', paired],
  ['extension.result', extensionResult],
  ['extension.error', extensionFailed],
  ['extension.send', extensionSent],
  ['extension.insert', extensionInserted],
  [
    'extension.show',
    (app, msg: { title: string; lines: string[] }) => app.show(msg.title, msg.lines)
  ],
  ['extensions.reloaded', extensionsReloaded]
])

export function receive(app: ProductApp, msg: { type: string }): Command {
  const handle = RECEIVERS.get(msg.type)
  return handle ? handle(app, msg as never) : null
}

function bootFailed(app: ProductApp, msg: Failure): Command {
  app.status = `Could not start: ${msg.error.message}`
  app.error = app.status
  return null
}

function spun(app: ProductApp) {
  app.frame++
  app.spinning = false
  return app.spin()
}

function chatReady(
  app: ProductApp,
  msg: {
    meshId: string
    agent: Agent
    chats: NonNullable<RpcResult<'listChats'>['chats']>
    chatId: string | null
  }
): Command {
  const { options } = app
  Object.assign(app, { meshId: msg.meshId, agent: msg.agent, chats: msg.chats })
  app.status = ''
  const fresh = options.newChat || !!options.initialPrompt
  const first = options.initialPrompt || app.queued
  options.initialPrompt = null
  app.queued = null
  options.newChat = false
  // plugin problems are said once, on the first screen that has room for them
  app.notice = app.extensions.problems.join(' · ')
  const open = app.openChat(fresh ? null : msg.chatId)
  if (options.resume) {
    options.resume = false
    app.openChats()
  }

  return app.tui.batch(
    open,
    first && app.send(first),
    app.watch('chats', () => app.engine!.chatsWatch({ meshId: msg.meshId })),
    app.watch('agents', () => app.engine!.agentsWatch({ meshId: msg.meshId }))
  )
}

function chunksArrived(
  app: ProductApp,
  msg: { tag?: number; value: WatchFrame<'chunksWatch'> }
): Command {
  if (msg.tag !== app.chatTag) {
    return null
  }

  return app.tui.batch(
    app.setTranscript(msg.value.chunks || []),
    app.watch('chunks', null, app.chatTag)
  )
}

function chunksEnded(app: ProductApp, msg: { tag?: number }): Command {
  if (msg.tag === app.chatTag) {
    app.notice = 'Lost the conversation stream · reopen it with ctrl+b'
  }

  return null
}

function chatsChanged(app: ProductApp, msg: Value<WatchFrame<'chatsWatch'>>): Command {
  app.chats = session.visibleChats(msg.value.chats)
  return app.watch('chats')
}

function agentsChanged(app: ProductApp, msg: Value<WatchFrame<'agentsWatch'>>): Command {
  const agent = (msg.value.agents || []).find((a) => a.id === app.agent?.id)
  if (agent) {
    app.agent = agent
  }

  return app.watch('agents')
}

function meshStatusChanged(app: ProductApp, msg: Value<WatchFrame<'meshStatusWatch'>>): Command {
  app.meshStatus = msg.value
  return app.watch('mesh-status')
}

function downloadsChanged(app: ProductApp, msg: Value<WatchFrame<'modelDownloadsWatch'>>): Command {
  app.modelDownloads = new Map((msg.value.downloads || []).map((d) => [d.name, d]))
  return app.watch('downloads')
}

function sent(app: ProductApp, msg: { chatId?: string | null }): Command {
  if (msg.chatId && msg.chatId !== app.chatId) {
    return app.openChat(msg.chatId)
  }

  return null
}

function sendFailed(app: ProductApp, msg: Failure & { text: string }): Command {
  app.awaiting = false
  if (!app.editor.value) {
    app.editor.set(msg.text)
  }

  app.notice = `Not sent: ${msg.error.message} · your message is back in the composer`

  return null
}

function agentUpdated(app: ProductApp, msg: Value<Agent & { note?: string }>): Command {
  const { note, ...agent } = msg.value
  app.agent = agent
  app.notice = note || `Chat model · ${agent.modelName}`
  return app.refresh()
}

function noticed(app: ProductApp, msg: Value<string>): Command {
  app.notice = msg.value
  return null
}

function forked(app: ProductApp, msg: Value<{ chatId: string; draft?: string }>): Command {
  const cmd = app.openChat(msg.value.chatId)
  if (msg.value.draft) {
    app.editor.set(msg.value.draft)
  }

  app.notice = 'Branched into a new conversation'

  return cmd
}

function shellFinished(
  app: ProductApp,
  msg: { cmd: string; quiet: boolean; result: { stdout: string; stderr: string; exitCode: number } }
): Command {
  const { cmd, quiet, result } = msg
  const output = [result.stdout, result.stderr].filter(Boolean).join('\n').trimEnd()
  app.notice = ''
  if (quiet) {
    app.show(`$ ${cmd}`, [
      ...output.split('\n').map((l) => paint(l, 'text')),
      '',
      paint(`exit ${result.exitCode}`, result.exitCode ? 'red' : 'green')
    ])
    return null
  }

  return app.send(
    `I ran \`${cmd}\` (exit ${result.exitCode}):\n\n\`\`\`\n${output.slice(0, 20000)}\n\`\`\``
  )
}

function attached(app: ProductApp, msg: Value<{ fileName: string; chatId: string }>): Command {
  app.notice = `Attached ${msg.value.fileName}`
  if (msg.value.chatId !== app.chatId) {
    return app.openChat(msg.value.chatId)
  }

  return null
}

function foldersListed(
  app: ProductApp,
  msg: Value<{ roots: (string | { path: string })[]; writes: string[] }>
): Command {
  const { roots, writes } = msg.value
  const grant = (root: string | { path: string }) => {
    const path = typeof root === 'string' ? root : root.path
    const writable = writes.includes(path)
    return paint(writable ? 'read + write  ' : 'read only     ', writable ? 'teal' : 'muted') + path
  }

  app.show('Folders', [
    paint('What this agent can use on this device', 'muted'),
    '',
    ...(roots.length ? roots.map(grant) : ['No folders granted yet.']),
    '',
    paint('/folders read <path>    grant read access', 'muted'),
    paint('/folders write <path>   grant read and write', 'muted'),
    paint('/folders remove <path>  revoke', 'muted')
  ])

  return null
}

function edited(app: ProductApp, msg: { text: string }): Command {
  if (typeof msg.text === 'string') {
    app.editor.set(msg.text.replace(/\n$/, ''))
  }

  return null
}

function screenLoaded(app: ProductApp, msg: { screen: ActiveScreen; value: ScreenData }): Command {
  const { screen, value } = msg
  if (screen !== app.screen) {
    return null
  }

  Object.assign(screen, { busy: false, rows: value.rows || [], note: value.note || [] })
  screen.cursor = Math.min(screen.cursor, Math.max(0, screen.rows.length - 1))

  return null
}

function screenFailed(_app: ProductApp, msg: Failure & { screen: ActiveScreen }): Command {
  Object.assign(msg.screen, { busy: false, error: msg.error.message })
  return null
}

function failed(app: ProductApp, msg: Failure): Command {
  app.notice = msg.error?.message || String(msg.error)
  return null
}

function snapshotArrived(
  app: ProductApp,
  msg: Value<Awaited<ReturnType<typeof snapshot>>>
): Command {
  app.product = msg.value
  app.hostStatus = app.options.readHostStatus?.() || null
  const choices = pageChoices(app)
  if (choices) {
    app.selection = Math.min(app.selection, Math.max(0, choices.length - 1))
  }

  if (!app.ready) {
    app.ready = true
    if (!app.product!.config?.onboardingCompleted && !app.options.skipSetup) {
      app.page = 'welcome'
    }
  }

  return null
}

function pageChoices(app: ProductApp) {
  if (app.page === 'workspaces') {
    return app.product!.meshes.filter((m) => m.workspace)
  }

  if (app.page === 'catalog') {
    return app.catalog || []
  }

  return app.page === 'models' ? app.product!.models : null
}

function polled(app: ProductApp) {
  return app.tui.batch(
    app.refresh(),
    app.tui.tick(2500, () => ({ type: 'product.poll' }))
  )
}

function snapshotFailed(app: ProductApp, msg: Failure): Command {
  if (app.restarting) {
    return null
  }

  app.error = msg.error.message

  return null
}

function actionFailed(app: ProductApp, msg: Failure): Command {
  app.actionBusy = false
  if (app.page === 'chat') {
    app.notice = msg.error.message
  } else {
    app.error = msg.error.message
  }

  return null
}

function actionDone(app: ProductApp) {
  app.actionBusy = false
  return app.refresh()
}

function joinPreviewed(app: ProductApp, msg: Value<RpcResult<'previewMeshInvite'>>): Command {
  app.actionBusy = false
  // setup pairs devices; a workspace is joined after it, from the overview
  if (msg.value?.memberInvite && app.inSetup()) {
    app.error =
      'That is a workspace link. Pair with one of your devices here, and join workspaces after setup.'
    app.page = 'join'

    return null
  }

  app.joinPreview = msg.value
  app.page = 'join-confirm'

  return null
}

function workspaceCreated(
  app: ProductApp,
  msg: Value<RpcResult<'createWorkspace'> | null>
): Command {
  app.actionBusy = false
  app.product!.workspace = (msg.value || null) as NonNullable<typeof app.product>['workspace']
  app.page = 'download'
  return app.refresh()
}

function invited(app: ProductApp, msg: Value<RpcResult<'meshInvite'>>): Command {
  app.actionBusy = false
  app.invitation = msg.value
  app.page = 'invite'
  return null
}

function catalogLoaded(app: ProductApp, msg: Value<RpcResult<'listModels'>>): Command {
  app.actionBusy = false
  app.catalog = msg.value.models || []
  app.selection = 0
  app.page = 'catalog'
  return null
}

// an Esc that cancelled the join already left the page
function paired(app: ProductApp) {
  return app.page === 'joining' ? app.finishOnboarding() : null
}

function onboarded(app: ProductApp) {
  app.actionBusy = false
  app.page = 'chat'
  return app.refresh()
}

// One line reads as a notice; anything longer opens the panel.
function extensionResult(app: ProductApp, msg: Value<unknown> & { extension: string }): Command {
  if (typeof msg.value !== 'string') return null
  if (!msg.value.includes('\n')) {
    app.notice = msg.value
    return null
  }

  return app.show(msg.extension, msg.value.split('\n'))
}

function extensionFailed(app: ProductApp, msg: Failure & { extension: string }): Command {
  app.notice = `Extension ${msg.extension} failed: ${msg.error.message}`
  return null
}

// A plugin's message is not the user's draft, so the draft survives it.
function extensionSent(app: ProductApp, msg: { text: string }): Command {
  const draft = app.editor.value
  const cmd = app.send(msg.text)
  app.editor.set(draft)
  return cmd
}

function extensionInserted(app: ProductApp, msg: { text: string }): Command {
  app.editor.insert(msg.text)
  return null
}

function extensionsReloaded(
  app: ProductApp,
  msg: { loaded: LoadedExtensions; pluginsChanged?: boolean }
): Command {
  app.extensions = app.loadExtensions(msg.loaded)
  applyTheme(app.extensions.theme)
  const plugins = msg.pluginsChanged ? ' · plugins changed: /plugins, then r to restart Core' : ''
  app.notice = (app.extensions.problems.join(' · ') || 'qvac.config reloaded') + plugins

  return null
}
