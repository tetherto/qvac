/**
 * Paired Assistant inbox example.
 *
 * This file demonstrates what Assistant adds on top of direct SDK inference:
 * one facade starts Sync and Harness, pairs two local Assistant processes,
 * accepts durable work from the peer, runs that work through a registered
 * agent, and lets the peer reopen later to read the replicated result and
 * persisted run outcome.
 *
 * Local two-terminal flow:
 *
 *   bun run --cwd packages/assistant inbox serve
 *   bun run --cwd packages/assistant inbox add "Reply with exactly OK"
 *   bun run --cwd packages/assistant inbox status
 *
 * The default profile stores host, peer, and invite data below the OS temp
 * directory, so the demo does not create a ~/.qvac application folder. Use
 * --profile <name> to run a second isolated demo, --invite <invite> when the
 * peer is on another machine, and --qwen on serve to use the real Qwen-backed
 * Harness path instead of the deterministic test model.
 */
import { access, mkdir, readFile, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  createAssistant,
  type AssistantFacade,
  type AssistantInference
} from '../index.ts'

const DEFAULT_PROFILE = 'default'
const DEFAULT_AGENT_ID = 'assistant-inbox-runner'
const DEFAULT_DETERMINISTIC_MODEL = 'deterministic'
const QWEN_CACHE_FILE = '3a65a2a3c6a30a47_Qwen3.5-4B-Q4_K_M.gguf'
const INVITE_EXPIRES_IN_MS = 30 * 60_000
const TASK_FORMAT = 'application/vnd.qvac.assistant-inbox.task+json'
const STATUS_ENTRY = 'qvac.assistant-inbox.status'
const ACCEPTANCE_TIMEOUT_MS = 30_000
const STREAM_PERSIST_INTERVAL_MS = 250

type InboxMode = 'serve' | 'add' | 'status'
type InboxStatus = 'pending' | 'running' | 'completed' | 'failed' | 'cancelled'
type TerminalInboxStatus = 'completed' | 'failed' | 'cancelled'

export interface InboxPaths {
  readonly root: string
  readonly hostStoragePath: string
  readonly peerStoragePath: string
  readonly invitePath: string
}

export type InboxCommand =
  | {
      readonly mode: 'serve'
      readonly profile: string
      readonly paths: InboxPaths
      readonly inference: AssistantInference
      readonly model: string
    }
  | {
      readonly mode: 'add'
      readonly profile: string
      readonly paths: InboxPaths
      readonly text: string
      readonly invite?: Buffer
    }
  | {
      readonly mode: 'status'
      readonly profile: string
      readonly paths: InboxPaths
    }

export interface InboxTask {
  readonly id: string
  readonly input: string
  readonly status: InboxStatus
  readonly result: string | null
  readonly createdAt: number
  readonly updatedAt: number
}

interface InboxWorkEndpoint {
  apply(
    command:
      | {
          readonly type: 'record-work'
          readonly workId: string
          readonly payload: Buffer
          readonly payloadFormat: string
          readonly payloadVersion: number
        }
      | {
          readonly type: 'append-journal'
          readonly workId: string
          readonly entryType: string
          readonly body: Buffer
        }
      | {
          readonly type: 'record-outcome'
          readonly workId: string
          readonly status: TerminalInboxStatus
          readonly result: Buffer
        },
    options: { readonly operationId: string }
  ): Promise<{ readonly revision: string }>
  query(
    query:
      | { readonly type: 'list-work' }
      | { readonly type: 'get-work'; readonly workId: string }
      | { readonly type: 'list-journal'; readonly workId: string }
  ): Promise<{
    readonly works?: readonly WorkSummary[]
    readonly work?: WorkRecord | null
    readonly entries?: readonly JournalEntry[]
  }>
  watch(
    query: { readonly type: 'list-work' },
    options?: { readonly signal?: AbortSignal }
  ): AsyncIterable<unknown>
}

interface WorkSummary {
  readonly workId: string
  readonly payloadFormat: string
  readonly createdAt: number
  readonly outcomeStatus?: string | null
  readonly outcomeResult?: Buffer | null
}

interface WorkRecord extends WorkSummary {
  readonly payload: Buffer
}

interface JournalEntry {
  readonly entryType: string
  readonly body: Buffer
  readonly recordedAt: number
}

export function resolveInboxPaths(profile = DEFAULT_PROFILE): InboxPaths {
  const safeProfile = normalizeProfile(profile)
  const root = join(tmpdir(), 'qvac-assistant-inbox', safeProfile)
  return {
    root,
    hostStoragePath: join(root, 'host'),
    peerStoragePath: join(root, 'peer'),
    invitePath: join(root, 'invite.json')
  }
}

export function parseInboxCommand(args: readonly string[]): InboxCommand {
  const mode = args[0]
  if (!isInboxMode(mode)) throw new Error(usage())
  const parsed = parseOptions(args.slice(1))
  const profile = normalizeProfile(parsed.profile ?? DEFAULT_PROFILE)
  const paths = resolveInboxPaths(profile)

  if (mode === 'serve') {
    if (parsed.rest.length > 0) throw new Error('serve does not accept task text')
    const inference: AssistantInference = parsed.qwen
      ? { kind: 'qwen' }
      : { kind: 'deterministic' }
    return {
      mode,
      profile,
      paths,
      inference,
      model: parsed.qwen
        ? parsed.model ?? defaultQwenModelPath()
        : DEFAULT_DETERMINISTIC_MODEL
    }
  }

  if (mode === 'add') {
    const text = parsed.rest.join(' ').trim()
    if (!text) throw new Error('add requires task text')
    return {
      mode,
      profile,
      paths,
      text,
      ...(parsed.invite ? { invite: decodeInvite(parsed.invite) } : {})
    }
  }

  if (parsed.rest.length > 0) throw new Error('status does not accept task text')
  return { mode, profile, paths }
}

export function encodeInvite(invite: Buffer) {
  return invite.toString('base64url')
}

export function decodeInvite(invite: string) {
  return Buffer.from(invite, 'base64url')
}

export function createInboxRepository(state: {
  readonly work: InboxWorkEndpoint
}) {
  const profile = state.work
  return {
    async create(input: string) {
      const id = createTaskId()
      await profile.apply(
        {
          type: 'record-work',
          workId: id,
          payload: Buffer.from(JSON.stringify({ input })),
          payloadFormat: TASK_FORMAT,
          payloadVersion: 1
        },
        { operationId: `inbox:create:${id}` }
      )
      return requireTask(await readTask(profile, id), id)
    },
    async update(request: {
      readonly id: string
      readonly status: InboxStatus
      readonly result?: string | null
    }) {
      const task = requireTask(await readTask(profile, request.id), request.id)
      const result = request.result ?? task.result
      if (task.status === request.status && task.result === result) return task
      if (isTerminal(request.status)) {
        await profile.apply(
          {
            type: 'record-outcome',
            workId: request.id,
            status: request.status,
            result: encodeResult(result)
          },
          { operationId: `inbox:outcome:${request.id}:${request.status}` }
        )
      } else {
        await profile.apply(
          {
            type: 'append-journal',
            workId: request.id,
            entryType: STATUS_ENTRY,
            body: Buffer.from(JSON.stringify({ status: request.status, result }))
          },
          {
            operationId: [
              'inbox:status',
              request.id,
              String(task.updatedAt),
              request.status,
              hashText(result ?? '')
            ].join(':')
          }
        )
      }
      return requireTask(await readTask(profile, request.id), request.id)
    },
    get(id: string) {
      return readTask(profile, id)
    },
    async list() {
      const result = await profile.query({ type: 'list-work' })
      const tasks = await Promise.all(
        (result.works ?? [])
          .filter(({ payloadFormat }) => payloadFormat === TASK_FORMAT)
          .map(({ workId }) => readTask(profile, workId))
      )
      return tasks
        .filter((task): task is InboxTask => task !== null)
        .sort((left, right) => left.createdAt - right.createdAt)
    },
    watch(options?: { readonly signal?: AbortSignal }) {
      return watchTasks(profile, options)
    }
  }
}

export async function runInboxCommand(command: InboxCommand): Promise<void> {
  if (command.mode === 'serve') {
    await serve(command)
    return
  }
  if (command.mode === 'add') {
    await add(command)
    return
  }
  await status(command)
}

async function serve(command: Extract<InboxCommand, { readonly mode: 'serve' }>) {
  const assistant = createAssistant({
    storagePath: command.paths.hostStoragePath,
    inference: command.inference
  })
  const controller = new AbortController()
  const removeShutdownHandlers = installShutdownHandlers(controller)
  try {
    await assistant.ready()
    await assistant.registerAgent({
      id: DEFAULT_AGENT_ID,
      model: command.model,
      instructions: 'Complete inbox tasks directly and concisely.',
      skills: [],
      toolPolicy: { allow: [], requireApproval: [] }
    })
    const invite = await assistant.state.mesh.createInvite({
      expiresInMs: INVITE_EXPIRES_IN_MS
    })
    await writeInvite(command.paths, invite)
    console.log(`▸ Serving Assistant inbox profile "${command.profile}"`)
    console.log(`▸ Local invite saved to ${command.paths.invitePath}`)
    console.log(`▸ Remote invite: ${encodeInvite(invite.invite)}`)
    console.log('▸ Add work from another terminal with:')
    console.log('bun packages/assistant/examples/assistant-inbox.ts add "Draft a release note"')
    await Promise.all([
      approvePairingRequests(assistant, controller.signal),
      processInbox(assistant, controller.signal)
    ])
  } finally {
    controller.abort('Assistant inbox stopped')
    removeShutdownHandlers()
    await assistant.close()
  }
}

async function add(command: Extract<InboxCommand, { readonly mode: 'add' }>) {
  const invite = command.invite ?? (await readInvite(command.paths))
  const assistant = createAssistant({
    storagePath: command.paths.peerStoragePath,
    inference: { kind: 'deterministic' }
  })
  try {
    await assistant.ready()
    await ensurePaired(assistant, invite)
    const inbox = createInboxRepository(assistant.state)
    const task = await inbox.create(command.text)
    console.log(`▸ Added task ${task.id}`)
    const accepted = await waitForTaskAcceptance(inbox, task.id, ACCEPTANCE_TIMEOUT_MS)
    if (accepted) {
      console.log(`▸ Task ${task.id} is ${accepted.status}`)
    } else {
      console.log(`▸ Task ${task.id} is pending`)
    }
  } finally {
    await assistant.close()
  }
}

async function status(command: Extract<InboxCommand, { readonly mode: 'status' }>) {
  const assistant = createAssistant({
    storagePath: command.paths.peerStoragePath,
    inference: { kind: 'deterministic' }
  })
  try {
    await assistant.ready()
    const inbox = createInboxRepository(assistant.state)
    const tasks = await inbox.list()
    if (tasks.length === 0) {
      console.log('▸ No inbox tasks found')
      return
    }
    for (const task of tasks) {
      console.log(`${task.id} ${task.status}`)
      if (task.result) console.log(task.result)
      const run = await assistant.readRun({
        agentId: DEFAULT_AGENT_ID,
        runId: runIdFor(task.id)
      })
      if (run?.outcome) {
        console.log(`▸ Run outcome: ${run.outcome.status}`)
      }
    }
  } finally {
    await assistant.close()
  }
}

async function processInbox(assistant: AssistantFacade, signal: AbortSignal) {
  const inbox = createInboxRepository(assistant.state)
  await processPendingTasks(assistant, inbox, signal)
  const iterator = inbox.watch({ signal })[Symbol.asyncIterator]()
  try {
    while (!signal.aborted) {
      const next = await nextUntilAbort(iterator, signal)
      if (next.done) return
      await processPendingTasks(assistant, inbox, signal)
    }
  } finally {
    if (!signal.aborted) await iterator.return?.()
  }
}

async function processPendingTasks(
  assistant: AssistantFacade,
  inbox: ReturnType<typeof createInboxRepository>,
  signal: AbortSignal
) {
  const tasks = (await inbox.list()).filter((task) => task.status === 'pending')
  for (const task of tasks) {
    if (signal.aborted) return
    await runTask(assistant, inbox, task, signal)
  }
}

async function runTask(
  assistant: AssistantFacade,
  inbox: ReturnType<typeof createInboxRepository>,
  task: InboxTask,
  signal: AbortSignal
) {
  let output = ''
  let lastPersistedAt = 0
  await inbox.update({ id: task.id, status: 'running', result: null })
  try {
    for await (const event of assistant.run({
      agentId: DEFAULT_AGENT_ID,
      runId: runIdFor(task.id),
      input: task.input,
      signal
    })) {
      if (event.type === 'content') {
        output += event.text ?? ''
        process.stdout.write(event.text ?? '')
        const now = Date.now()
        if (now - lastPersistedAt >= STREAM_PERSIST_INTERVAL_MS) {
          lastPersistedAt = now
          await inbox.update({ id: task.id, status: 'running', result: output })
        }
      } else if (event.type === 'error') {
        throw new Error(event.message)
      } else if (event.type === 'aborted') {
        throw new Error(abortMessage(signal.reason))
      }
    }
    if (output) process.stdout.write('\n')
    await inbox.update({ id: task.id, status: 'completed', result: output })
    console.log(`▸ Completed task ${task.id}`)
  } catch (error) {
    await inbox.update({
      id: task.id,
      status: signal.aborted ? 'cancelled' : 'failed',
      result: signal.aborted ? abortMessage(signal.reason) : errorMessage(error)
    })
  }
}

async function approvePairingRequests(
  assistant: AssistantFacade,
  signal: AbortSignal
) {
  const handled = new Set<string>()
  const iterator =
    assistant.state.mesh.watchPairingRequests()[Symbol.asyncIterator]()
  try {
    while (!signal.aborted) {
      const next = await nextUntilAbort(iterator, signal)
      if (next.done) return
      for (const request of next.value.requests) {
        const id = request.id.toString('hex')
        if (request.status !== 'pending' || handled.has(id)) continue
        handled.add(id)
        await assistant.state.mesh.approvePairingRequest(request.id)
        console.log(`▸ Approved paired writer ${request.fingerprint}`)
      }
    }
  } finally {
    if (!signal.aborted) await iterator.return?.()
  }
}

async function ensurePaired(assistant: AssistantFacade, invite: Buffer) {
  const devices = await assistant.state.mesh.listDevices()
  if (devices.some((device) => !device.local)) return
  console.log('▸ Joining Assistant inbox')
  await assistant.state.mesh.join(invite)
}

async function waitForTaskAcceptance(
  inbox: ReturnType<typeof createInboxRepository>,
  taskId: string,
  timeoutMs: number
) {
  const current = await inbox.get(taskId)
  if (current && current.status !== 'pending') return current
  const controller = new AbortController()
  let timeout: ReturnType<typeof setTimeout> | null = null
  const timedOut = new Promise<null>((resolve) => {
    timeout = setTimeout(() => {
      controller.abort('Timed out waiting for task acceptance')
      resolve(null)
    }, timeoutMs)
  })
  const changed = (async () => {
    const iterator = inbox.watch({ signal: controller.signal })[Symbol.asyncIterator]()
    try {
      while (!controller.signal.aborted) {
        const next = await nextUntilAbort(iterator, controller.signal)
        if (next.done) return null
        const task = next.value.find((candidate) => candidate.id === taskId)
        if (task && task.status !== 'pending') return task
      }
      return null
    } finally {
      if (!controller.signal.aborted) await iterator.return?.()
    }
  })()
  try {
    return await Promise.race([changed, timedOut])
  } finally {
    controller.abort('Task acceptance wait finished')
    if (timeout) clearTimeout(timeout)
  }
}

async function* watchTasks(
  profile: InboxWorkEndpoint,
  options?: { readonly signal?: AbortSignal }
) {
  for await (const _frame of profile.watch({ type: 'list-work' }, options)) {
    const result = await profile.query({ type: 'list-work' })
    const tasks = await Promise.all(
      (result.works ?? [])
        .filter(({ payloadFormat }) => payloadFormat === TASK_FORMAT)
        .map(({ workId }) => readTask(profile, workId))
    )
    yield tasks.filter((task): task is InboxTask => task !== null)
  }
}

async function readTask(profile: InboxWorkEndpoint, id: string) {
  const [workResult, journalResult] = await Promise.all([
    profile.query({ type: 'get-work', workId: id }),
    profile.query({ type: 'list-journal', workId: id })
  ])
  const work = workResult.work
  if (!work || work.payloadFormat !== TASK_FORMAT) return null
  const payload = decodePayload(work.payload)
  const latest = (journalResult.entries ?? [])
    .filter(({ entryType }) => entryType === STATUS_ENTRY)
    .at(-1)
  const progress = latest ? decodeProgress(latest.body) : null
  return {
    id: work.workId,
    input: payload.input,
    status: decodeStatus(work.outcomeStatus ?? progress?.status ?? 'pending'),
    result: work.outcomeResult
      ? decodeResult(work.outcomeResult)
      : progress?.result ?? null,
    createdAt: work.createdAt,
    updatedAt: latest?.recordedAt ?? work.createdAt
  } satisfies InboxTask
}

function requireTask(task: InboxTask | null, id: string) {
  if (!task) throw new Error(`Task not found: ${id}`)
  return task
}

function decodePayload(payload: Buffer) {
  const value: unknown = JSON.parse(payload.toString('utf8'))
  if (typeof value !== 'object' || value === null) {
    throw new Error('Invalid inbox task payload')
  }
  const input = Reflect.get(value, 'input')
  if (typeof input !== 'string') throw new Error('Invalid inbox task payload')
  return { input }
}

function decodeProgress(body: Buffer) {
  const value: unknown = JSON.parse(body.toString('utf8'))
  if (typeof value !== 'object' || value === null) {
    throw new Error('Invalid inbox task progress')
  }
  const status = decodeStatus(Reflect.get(value, 'status'))
  const result = Reflect.get(value, 'result')
  if (result !== null && typeof result !== 'string') {
    throw new Error('Invalid inbox task progress')
  }
  return { status, result }
}

function encodeResult(result: string | null) {
  return Buffer.from(JSON.stringify({ result }))
}

function decodeResult(result: Buffer) {
  const value: unknown = JSON.parse(result.toString('utf8'))
  if (typeof value !== 'object' || value === null) {
    throw new Error('Invalid inbox task result')
  }
  const decoded = Reflect.get(value, 'result')
  if (decoded !== null && typeof decoded !== 'string') {
    throw new Error('Invalid inbox task result')
  }
  return decoded
}

function decodeStatus(value: unknown): InboxStatus {
  if (
    value === 'pending' ||
    value === 'running' ||
    value === 'completed' ||
    value === 'failed' ||
    value === 'cancelled'
  ) {
    return value
  }
  throw new Error('Invalid inbox task status')
}

function isTerminal(status: InboxStatus): status is TerminalInboxStatus {
  return status === 'completed' || status === 'failed' || status === 'cancelled'
}

function runIdFor(taskId: string) {
  return `inbox-${taskId}`
}

function createTaskId() {
  const entropy = Math.floor(Math.random() * 0x1_0000_0000)
    .toString(36)
    .padStart(7, '0')
  return `task-${Date.now().toString(36)}-${entropy}`
}

function normalizeProfile(profile: string) {
  if (!/^[a-zA-Z0-9._-]+$/.test(profile)) {
    throw new Error('--profile may contain only letters, numbers, dot, underscore, and dash')
  }
  return profile
}

function isInboxMode(value: string | undefined): value is InboxMode {
  return value === 'serve' || value === 'add' || value === 'status'
}

function parseOptions(args: readonly string[]) {
  const rest: string[] = []
  let profile: string | undefined
  let invite: string | undefined
  let model: string | undefined
  let qwen = false
  for (let index = 0; index < args.length; index++) {
    const arg = args[index]
    if (arg === '--profile') {
      profile = requireOptionValue(args, ++index, '--profile')
    } else if (arg === '--invite') {
      invite = requireOptionValue(args, ++index, '--invite')
    } else if (arg === '--model') {
      model = requireOptionValue(args, ++index, '--model')
    } else if (arg === '--qwen') {
      qwen = true
    } else if (arg?.startsWith('--')) {
      throw new Error(`Unknown option: ${arg}`)
    } else if (arg !== undefined) {
      rest.push(arg)
    }
  }
  return { profile, invite, model, qwen, rest }
}

function requireOptionValue(args: readonly string[], index: number, option: string) {
  const value = args[index]
  if (!value || value.startsWith('--')) throw new Error(`${option} requires a value`)
  return value
}

async function writeInvite(
  paths: InboxPaths,
  invite: { readonly invite: Buffer; readonly expiresAt: number }
) {
  await mkdir(paths.root, { recursive: true })
  await writeFile(
    paths.invitePath,
    `${JSON.stringify(
      {
        version: 1,
        invite: encodeInvite(invite.invite),
        expiresAt: invite.expiresAt
      },
      null,
      2
    )}\n`
  )
}

async function readInvite(paths: InboxPaths) {
  try {
    await access(paths.invitePath)
  } catch {
    throw new Error(
      `No local invite found at ${paths.invitePath}. Start "serve" first or pass --invite.`
    )
  }
  const value: unknown = JSON.parse(await readFile(paths.invitePath, 'utf8'))
  if (typeof value !== 'object' || value === null) {
    throw new Error('Invalid local invite file')
  }
  const invite = Reflect.get(value, 'invite')
  if (typeof invite !== 'string') throw new Error('Invalid local invite file')
  return decodeInvite(invite)
}

function installShutdownHandlers(controller: AbortController) {
  function stop(signal: 'SIGINT' | 'SIGTERM') {
    console.log(`\n▸ Stopping Assistant inbox after ${signal}`)
    controller.abort(`Assistant inbox stopped by ${signal}`)
  }
  function onSigint() {
    stop('SIGINT')
  }
  function onSigterm() {
    stop('SIGTERM')
  }
  process.once('SIGINT', onSigint)
  process.once('SIGTERM', onSigterm)
  return function removeShutdownHandlers() {
    process.removeListener('SIGINT', onSigint)
    process.removeListener('SIGTERM', onSigterm)
  }
}

async function nextUntilAbort<T>(
  iterator: AsyncIterator<T>,
  signal: AbortSignal
): Promise<IteratorResult<T>> {
  if (signal.aborted) return { done: true, value: undefined }
  let onAbort = () => {}
  const aborted = new Promise<IteratorResult<T>>((resolve) => {
    onAbort = () => resolve({ done: true, value: undefined })
    signal.addEventListener('abort', onAbort, { once: true })
  })
  try {
    return await Promise.race([iterator.next(), aborted])
  } finally {
    signal.removeEventListener('abort', onAbort)
  }
}

function hashText(value: string) {
  let hash = 2166136261
  for (let index = 0; index < value.length; index++) {
    hash ^= value.charCodeAt(index)
    hash = Math.imul(hash, 16777619)
  }
  return (hash >>> 0).toString(16)
}

function defaultQwenModelPath() {
  const storageRoot = process.env.QVAC_SDK_STORAGE_ROOT ?? join(homedir(), '.qvac')
  return join(storageRoot, 'models', QWEN_CACHE_FILE)
}

function abortMessage(reason: unknown) {
  return typeof reason === 'string' ? reason : 'Assistant inbox stopped'
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error)
}

function usage() {
  return [
    'Usage:',
    '  assistant-inbox serve [--profile <name>] [--qwen] [--model <path-or-registry-url>]',
    '  assistant-inbox add [--profile <name>] [--invite <invite>] <task text>',
    '  assistant-inbox status [--profile <name>]'
  ].join('\n')
}

const isMain =
  import.meta.main === true ||
  process.argv[1] === fileURLToPath(import.meta.url)

if (isMain) {
  try {
    await runInboxCommand(parseInboxCommand(process.argv.slice(2)))
  } catch (error) {
    console.error('✖', errorMessage(error))
    process.exitCode = 1
  }
}
