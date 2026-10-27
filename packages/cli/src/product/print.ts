import type { Agent } from '../lib/types.js'
import type { AgentTurn, Chunk, Turn } from './transcript.js'
import type { WatchFrame } from './app-types.js'
type Input = AsyncIterable<Uint8Array | string> | Iterable<Uint8Array | string>
export interface PrintIO {
  stdin?: Input | null | undefined
  stdout: { write(text: string): unknown }
  stderr: { write(text: string): unknown }
  context?: string
}
interface RunOptions {
  deviceId: Uint8Array | null
  options: LaunchOptions
  io: PrintIO
}
interface Run extends RunOptions {
  engine: Capabilities
}
interface Prepared {
  meshId: string
  agent: Agent
  chatId: string | null
}
type ChunkWatch = AsyncIterator<WatchFrame<'chunksWatch'>>
interface Follow {
  engine: Capabilities
  options: LaunchOptions
  io: PrintIO
  json: boolean
  meshId: string
  runId: string
  fresh: ReturnType<typeof differ>
  answered: Set<string | undefined>
  printed: number
  turn: AgentTurn | null
}
interface RpcRequest {
  id?: unknown
  type: string
  text?: unknown
  model?: unknown
  chunkId?: unknown
  approved?: unknown
  scope?: unknown
}
type RpcCommands = Record<string, (command: RpcRequest) => unknown | Promise<unknown>>
const errorMessage = (error: unknown) => (error instanceof Error ? error.message : String(error))
const buffer = (value: Uint8Array | string) =>
  typeof value === 'string' ? b4a.from(value) : b4a.from(value)
import type { Capabilities } from '@qvac/core/client'
import type { LaunchOptions } from '../lib/types.js'
import b4a from 'b4a'
import * as session from './session.js'
import { turns, pendingApproval, activeRun, settled } from './transcript.js'

function replacer(this: Record<string, unknown>, key: string, value: unknown) {
  const raw = this[key]
  return raw instanceof Uint8Array ? b4a.toHex(raw) : value
}

const line = (value: unknown) => JSON.stringify(value, replacer) + '\n'

async function readAll(stdin: Input) {
  const parts = []
  for await (const data of stdin) {
    parts.push(buffer(data))
  }

  return b4a.toString(b4a.concat(parts))
}

async function* lines(stdin: Input) {
  let rest = b4a.alloc(0)
  for await (const data of stdin) {
    rest = b4a.concat([rest, buffer(data)])
    let at
    while ((at = rest.indexOf(10)) !== -1) {
      yield b4a.toString(rest.subarray(0, at))
      rest = rest.subarray(at + 1)
    }
  }

  if (rest.length) {
    yield b4a.toString(rest)
  }
}

async function prepare(
  engine: Capabilities,
  deviceId: Uint8Array | null,
  options: LaunchOptions
): Promise<Prepared> {
  const meshId = await session.accountMesh(engine)
  await session.writable(engine, meshId)
  const config = await engine.getConfig({})
  let agent = await session.chooseAgent(engine, meshId, {
    deviceId,
    remembered: config.activeAgentId,
    modelName: options.model
  })
  if (options.model && agent.modelName !== options.model) {
    agent = await engine.updateAgent({
      meshId,
      agentId: agent.id,
      config: { modelName: options.model }
    })
  }

  let chatId = options.chat || null
  if (!chatId && options.continue) {
    const chats = session.visibleChats((await engine.listChats({ meshId })).chats)
    chatId = (chats.find((c) => c.id === config.activeChatId) || chats[0])?.id ?? null
  }

  return { meshId, agent, chatId }
}

// Chunks the caller has not seen yet, or whose content changed (a run-status is amended in place).
function differ() {
  const seen = new Map<string, string>()
  return (chunks: Chunk[]) =>
    chunks.filter((chunk) => {
      const json = line(chunk)
      if (seen.get(chunk.id) === json) {
        return false
      }

      seen.set(chunk.id, json)

      return true
    })
}

const contentOf = (turn: AgentTurn) =>
  turn.segments
    .filter((s: { type: string }) => s.type === 'content')
    .map((s) => s.text)
    .join('\n\n')

// a new chat opens with the project's AGENTS.md, as the chat app's does; the title is the prompt's
const message = ({ meshId, agent, chatId }: Prepared, text: string, context = '') =>
  chatId
    ? { meshId, chatId, text }
    : { meshId, agentId: agent.id, text: context + text, title: text.split('\n')[0]!.slice(0, 48) }

export function runPrint(engine: Capabilities, { deviceId, options, io }: RunOptions) {
  const run = { engine, deviceId, options, io }
  return options.mode === 'rpc' ? rpc(run) : once(run)
}

async function once({ engine, deviceId, options, io }: Run) {
  const json = options.mode === 'json'
  const piped = io.stdin ? (await readAll(io.stdin)).trimEnd() : ''
  const text = [piped, options.prompt?.trim()].filter(Boolean).join('\n\n')
  if (!text) {
    io.stderr.write('qvac: no prompt given. Pass -p "prompt" or pipe text on stdin.\n')
    return 2
  }

  const prepared = await prepare(engine, deviceId, options)
  const { meshId, agent } = prepared
  const fresh = differ()
  let watch = prepared.chatId ? await watchPast(engine, { ...prepared, fresh }) : null

  const { chatId, runId } = await engine.sendMessage(message(prepared, text, io.context))
  await session.remember(engine, { agentId: agent.id, chatId }).catch(noop)
  if (json) {
    io.stdout.write(line({ type: 'session', chatId, meshId, runId, model: agent.modelName }))
  }

  watch ||= engine.chunksWatch({ meshId, chatId: chatId! })[Symbol.asyncIterator]()
  const follow: Follow = {
    engine,
    options,
    io,
    json,
    meshId,
    runId,
    fresh,
    answered: new Set(),
    printed: 0,
    turn: null
  }
  try {
    while (true) {
      const { value, done } = await watch.next()
      if (done || (await step(follow, value.chunks || []))) {
        break
      }
    }
  } finally {
    await watch.return?.(undefined)
  }

  return finish(follow)
}

// The chunks already in a continued chat are seen, so only this run's output is printed.
async function watchPast(
  engine: Capabilities,
  { meshId, chatId, fresh }: Prepared & { fresh: ReturnType<typeof differ> }
) {
  const watch = engine.chunksWatch({ meshId, chatId: chatId! })[Symbol.asyncIterator]()
  const first = await watch.next()
  if (!first.done) {
    fresh(first.value.chunks || [])
  }

  return watch
}

async function step(follow: Follow, chunks: Chunk[]) {
  if (follow.json) {
    for (const chunk of follow.fresh(chunks)) {
      follow.io.stdout.write(line({ type: 'chunk', chunk }))
    }
  }

  follow.turn =
    turns(chunks).find((t): t is AgentTurn => t.from === 'agent' && t.runId === follow.runId) ||
    null
  if (!follow.turn) {
    return false
  }

  if (!follow.json) {
    const out = contentOf(follow.turn)
    if (out.length > follow.printed) {
      follow.io.stdout.write(out.slice(follow.printed))
    }

    follow.printed = out.length
  }

  await answerPending(follow)

  return settled(follow.turn)
}

async function answerPending(follow: Follow) {
  const { turn, io } = follow
  if (!turn) return
  const pending = turn.segments.find(
    (s) => s.type === 'approval' && s.detail.status === 'pending' && !follow.answered.has(s.id)
  )
  if (!pending || settled(turn)) {
    return
  }

  follow.answered.add(pending.id)
  const approved = !!follow.options.yes
  if (follow.json) {
    io.stdout.write(
      line({
        type: 'approval',
        chunkId: pending.id,
        name: pending.detail.name,
        arguments: pending.detail.arguments,
        approved
      })
    )
  } else if (!approved) {
    io.stderr.write(
      `qvac: denied ${pending.detail.name || 'a tool call'} (pass --yes to approve)\n`
    )
  }

  await follow.engine.resolveApproval({
    meshId: follow.meshId,
    chunkId: pending.id!,
    approved,
    scope: 'once',
    agentId: pending.detail.agentId ?? null
  })
}

function finish({ turn, json, io, printed }: Follow) {
  const done = !!turn && settled(turn)
  const status = done ? turn.status : 'failed'
  const reason = done ? turn.run?.reason || null : 'Core closed before the run settled'
  if (json) {
    io.stdout.write(line({ type: 'end', status, reason }))
  } else {
    if (turn && printed && !contentOf(turn).endsWith('\n')) {
      io.stdout.write('\n')
    }

    if (status !== 'completed') {
      io.stderr.write(`qvac: run ${status}${reason ? `: ${reason}` : ''}\n`)
    }
  }

  return status === 'completed' ? 0 : 1
}

async function rpc({ engine, deviceId, options, io }: Run) {
  const state = await prepare(engine, deviceId, options)
  const rpcSession = new RpcSession(engine, { io, state })
  const commands = rpcCommands(rpcSession)
  if (state.chatId) {
    rpcSession.open(state.chatId, { quiet: true })
  }

  for await (const raw of lines(io.stdin ?? [])) {
    if (!raw.trim()) continue
    await respond(rpcSession, { commands, raw })
  }

  if (rpcSession.running()) {
    await new Promise<void>((resolve) => rpcSession.waiters.push(resolve))
  }

  rpcSession.open(null)

  return 0
}

async function respond(
  rpcSession: RpcSession,
  { commands, raw }: { commands: RpcCommands; raw: string }
) {
  let command: RpcRequest
  try {
    const parsed: unknown = JSON.parse(raw)
    if (
      !parsed ||
      typeof parsed !== 'object' ||
      !('type' in parsed) ||
      typeof parsed.type !== 'string'
    ) {
      throw new Error('invalid command')
    }
    command = parsed as RpcRequest
  } catch {
    rpcSession.emit({ type: 'response', ok: false, error: 'invalid JSON' })
    return
  }

  const { id = null, type } = command
  try {
    if (!Object.hasOwn(commands, type)) {
      throw new Error(`unknown command ${type}`)
    }

    const data = await commands[type]!(command)
    rpcSession.emit({ id, type: 'response', command: type, ok: true, data })
  } catch (error) {
    rpcSession.emit({ id, type: 'response', command: type, ok: false, error: errorMessage(error) })
  }
}

class RpcSession {
  engine: Capabilities
  io: PrintIO
  state: Prepared
  watch: ChunkWatch | null
  list: Turn[]
  pendingRun: string | null
  waiters: (() => void)[]
  answered: Set<string | undefined>
  ended: Set<string | null | undefined>

  constructor(engine: Capabilities, { io, state }: { io: PrintIO; state: Prepared }) {
    this.engine = engine
    this.io = io
    this.state = state
    this.watch = null
    this.list = []
    this.pendingRun = null
    this.waiters = []
    this.answered = new Set()
    this.ended = new Set()
  }

  emit(value: unknown) {
    this.io.stdout.write(line(value))
  }

  running() {
    return !!this.pendingRun || !!activeRun(this.list)
  }

  wake() {
    if (this.running()) return
    for (const resolve of this.waiters.splice(0)) {
      resolve()
    }
  }

  open(chatId: string | null, { quiet = false } = {}) {
    this.watch?.return?.(undefined).catch(noop)
    this.watch = null
    this.list = []
    this.pendingRun = null
    this.state.chatId = chatId
    if (!chatId) {
      return this.wake()
    }

    const watch = this.engine.chunksWatch({ meshId: this.state.meshId, chatId })
    this.watch = watch[Symbol.asyncIterator]()
    this.pump(this.watch, { quiet })
  }

  // quiet: the chat's past is already settled, so it is recorded rather than replayed
  async pump(iterator: ChunkWatch, { quiet }: { quiet: boolean }) {
    const fresh = differ()
    let replay = !quiet
    try {
      while (true) {
        const { value, done } = await iterator.next()
        if (done || iterator !== this.watch) {
          break
        }

        const chunks = value.chunks || []
        const changed = fresh(chunks)
        this.list = turns(chunks)
        if (replay) {
          this.publish(changed)
        } else {
          this.recordSettled()
        }

        replay = true
      }
    } catch (error) {
      if (iterator === this.watch) {
        this.emit({ type: 'error', error: errorMessage(error) })
      }
    }

    if (iterator === this.watch) {
      this.pendingRun = null
      this.wake()
    }
  }

  recordSettled() {
    for (const t of this.list) {
      if (t.from === 'agent' && settled(t)) {
        this.ended.add(t.runId)
      }
    }
  }

  publish(changed: Chunk[]) {
    for (const chunk of changed) {
      this.emit({ type: 'chunk', chunk })
    }

    this.offerApproval()
    this.endSettled()
    this.wake()
  }

  offerApproval() {
    const pending = pendingApproval(this.list)
    if (!pending || this.answered.has(pending.id)) {
      return
    }

    this.answered.add(pending.id)
    this.emit({
      type: 'approval',
      chunkId: pending.id,
      name: pending.detail.name,
      arguments: pending.detail.arguments,
      agentId: pending.detail.agentId ?? null
    })
  }

  endSettled() {
    for (const t of this.list) {
      if (t.from !== 'agent' || !settled(t) || this.ended.has(t.runId)) continue
      this.ended.add(t.runId)
      if (t.runId === this.pendingRun) {
        this.pendingRun = null
      }

      this.emit({ type: 'end', runId: t.runId, status: t.status, reason: t.run?.reason || null })
    }
  }
}

function rpcCommands(rpcSession: RpcSession): RpcCommands {
  const { engine, state } = rpcSession
  return {
    async prompt({ text }) {
      if (typeof text !== 'string' || !text) throw new Error('prompt needs text')
      const { agent, chatId } = state
      const result = await engine.sendMessage(message(state, text, rpcSession.io.context))
      if (result.chatId !== chatId) {
        rpcSession.open(result.chatId)
        await session.remember(engine, { agentId: agent.id, chatId: result.chatId }).catch(noop)
      }

      rpcSession.pendingRun = result.runId

      return { chatId: result.chatId, runId: result.runId }
    },
    async abort() {
      const runId = activeRun(rpcSession.list)?.runId || rpcSession.pendingRun
      if (!runId) {
        return { stopped: false }
      }

      await engine.stopRun({ meshId: state.meshId, chatId: state.chatId!, runId })

      return { stopped: true, runId }
    },
    async approve({ chunkId, approved, scope }) {
      if (typeof chunkId !== 'string' || !chunkId) throw new Error('approve needs chunkId')
      const segment = rpcSession.list
        .flatMap((t) => (t.from === 'agent' ? t.segments : []))
        .find((s) => s.id === chunkId)
      await engine.resolveApproval({
        meshId: state.meshId,
        chunkId,
        approved: approved === true,
        scope: scope === 'always' ? 'always' : 'once',
        agentId: segment?.detail.agentId ?? null
      })

      return {}
    },
    new_session() {
      rpcSession.open(null)
      return { chatId: null }
    },
    get_state() {
      return {
        chatId: state.chatId,
        meshId: state.meshId,
        agentId: state.agent.id,
        model: state.agent.modelName,
        running: rpcSession.running()
      }
    },
    get_messages() {
      return { messages: rpcSession.list }
    },
    async set_model({ model }) {
      if (typeof model !== 'string' || !model) throw new Error('set_model needs model')
      state.agent = await engine.updateAgent({
        meshId: state.meshId,
        agentId: state.agent.id,
        config: { modelName: model }
      })

      return { model: state.agent.modelName }
    },
    async get_available_models() {
      const { models = [] } = await engine.listModels({ cachedOnly: true })
      return {
        models: (models ?? []).filter((m) => m.taskType === 'llm' || m.type === 'completion')
      }
    }
  }
}

function noop() {}
