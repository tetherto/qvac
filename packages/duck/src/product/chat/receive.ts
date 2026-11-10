import type { ActiveScreen, Attachment, Command, RpcResult, WatchFrame } from '../app-types.js'
import type { ScreenData, ScreenPanel } from '../screen.js'
import { visibleChats } from '../session.js'
import type { Agent } from '@qvac/cli-kit/config'
import { applyTheme, paint } from '@qvac/cli-kit/brand'
import type { ChatApp } from './app.js'
import type { LoadedExtensions } from '../extensions.js'
type Value<T> = { value: T }
type Failure = { error: Error }

export const RECEIVERS = new Map<string, (app: ChatApp, msg: never) => Command>([
  ['chat.ready', chatReady],
  ['chunks', chunksArrived],
  ['chunks.end', chunksEnded],
  ['chats', chatsChanged],
  ['agents', agentsChanged],
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

function chatReady(
  app: ChatApp,
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
  app: ChatApp,
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

function chunksEnded(app: ChatApp, msg: { tag?: number }): Command {
  if (msg.tag === app.chatTag) {
    app.notice = 'Lost the conversation stream · reopen it with ctrl+b'
  }

  return null
}

function chatsChanged(app: ChatApp, msg: Value<WatchFrame<'chatsWatch'>>): Command {
  app.chats = visibleChats(msg.value.chats)
  return app.watch('chats')
}

function agentsChanged(app: ChatApp, msg: Value<WatchFrame<'agentsWatch'>>): Command {
  const agent = (msg.value.agents || []).find((a) => a.id === app.agent?.id)
  if (agent) {
    app.agent = agent
  }

  return app.watch('agents')
}

function sent(app: ChatApp, msg: { chatId?: string | null }): Command {
  if (msg.chatId && msg.chatId !== app.chatId) {
    return app.openChat(msg.chatId)
  }

  return null
}

function sendFailed(app: ChatApp, msg: Failure & { text: string }): Command {
  app.awaiting = false
  if (!app.editor.value) {
    app.editor.set(msg.text)
  }

  app.notice = `Not sent: ${msg.error.message} · your message is back in the composer`

  return null
}

function agentUpdated(app: ChatApp, msg: Value<Agent & { note?: string }>): Command {
  const { note, ...agent } = msg.value
  app.agent = agent
  app.notice = note || `Chat model · ${agent.modelName}`
  return app.refresh()
}

function noticed(app: ChatApp, msg: Value<string>): Command {
  app.notice = msg.value
  return null
}

function forked(app: ChatApp, msg: Value<{ chatId: string; draft?: string }>): Command {
  const cmd = app.openChat(msg.value.chatId)
  if (msg.value.draft) {
    app.editor.set(msg.value.draft)
  }

  app.notice = 'Branched into a new conversation'

  return cmd
}

function shellFinished(
  app: ChatApp,
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

function attached(app: ChatApp, msg: Value<{ fileName: string; chatId: string }>): Command {
  app.notice = `Attached ${msg.value.fileName}`
  if (msg.value.chatId !== app.chatId) {
    return app.openChat(msg.value.chatId)
  }

  return null
}

function foldersListed(
  app: ChatApp,
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

function edited(app: ChatApp, msg: { text: string }): Command {
  if (typeof msg.text === 'string') {
    app.editor.set(msg.text.replace(/\n$/, ''))
  }

  return null
}

function screenLoaded(app: ChatApp, msg: { screen: ActiveScreen; value: ScreenData }): Command {
  const { screen, value } = msg
  if (screen !== app.screen) {
    return null
  }

  Object.assign(screen, { busy: false, rows: value.rows || [], note: value.note || [] })
  screen.cursor = Math.min(screen.cursor, Math.max(0, screen.rows.length - 1))

  return null
}

function screenFailed(_app: ChatApp, msg: Failure & { screen: ActiveScreen }): Command {
  Object.assign(msg.screen, { busy: false, error: msg.error.message })
  return null
}

// One line reads as a notice; anything longer opens the panel.
function extensionResult(app: ChatApp, msg: Value<unknown> & { extension: string }): Command {
  if (typeof msg.value !== 'string') return null
  if (!msg.value.includes('\n')) {
    app.notice = msg.value
    return null
  }

  return app.show(msg.extension, msg.value.split('\n'))
}

function extensionFailed(app: ChatApp, msg: Failure & { extension: string }): Command {
  app.notice = `Extension ${msg.extension} failed: ${msg.error.message}`
  return null
}

// A plugin's message is not the user's draft, so the draft survives it.
function extensionSent(app: ChatApp, msg: { text: string }): Command {
  const draft = app.editor.value
  const cmd = app.send(msg.text)
  app.editor.set(draft)
  return cmd
}

function extensionInserted(app: ChatApp, msg: { text: string }): Command {
  app.editor.insert(msg.text)
  return null
}

function extensionsReloaded(
  app: ChatApp,
  msg: { loaded: LoadedExtensions; pluginsChanged?: boolean }
): Command {
  app.extensions = app.loadExtensions(msg.loaded)
  applyTheme(app.extensions.theme)
  const plugins = msg.pluginsChanged ? ' · plugins changed: /plugins, then r to restart Core' : ''
  app.notice = (app.extensions.problems.join(' · ') || 'qvac.config reloaded') + plugins

  return null
}
