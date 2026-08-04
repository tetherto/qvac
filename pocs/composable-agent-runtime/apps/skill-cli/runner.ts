import type {
  HarnessAgentRegistration,
  HarnessAbortSignal,
  HarnessEvent,
  HarnessJsonValue,
  HarnessRuntime
} from '@qvac/harness'
import { createHarness } from '@qvac/harness'

const COMMANDS = ['smoke', 'weather', 'obsidian', 'image', 'all'] as const
const DIFFUSION_PREDICTIONS = [
  'auto',
  'eps',
  'v',
  'edm_v',
  'flow',
  'flux2_flow'
] as const
const DEFAULT_TIMEOUT_MS = 5 * 60_000
const DEFAULT_CLEANUP_TIMEOUT_MS = 2_000
const DEFAULT_CANCELLATION_TIMEOUT_MS = 2_000
const BARE_RUNTIME_PROBE_OUTPUT = 'QVAC_BARE_RUNTIME_PROBE_V1'
const RUNNER_OBSIDIAN_ACCESS: 'read-only' = 'read-only'
const RUNNER_OBSIDIAN_OPERATIONS = [
  'files',
  'search',
  'read',
  'daily:read',
  'version'
] as const

type RunnerCommand = (typeof COMMANDS)[number]
type DiffusionPrediction = (typeof DIFFUSION_PREDICTIONS)[number]

export interface RunnerConfig {
  readonly command: RunnerCommand
  readonly qwenModel?: string
  readonly diffusion?: {
    readonly model: string
    readonly prediction?: DiffusionPrediction
  }
  readonly attachmentBase?: string
  readonly bareExecutable?: string
  readonly obsidian?: {
    readonly executablePath: string
    readonly vaultRoot: string
    readonly vaultIdentity: string
  }
  readonly obsidianApproval: boolean
  readonly timeoutMs: number
}

export interface RunnerPreflightPort {
  readonly platform: string
  readonly bareProbeEntry: string
  inspect(path: string): Promise<'file' | 'directory' | 'missing'>
  realpath(path: string): Promise<string>
  inspectExecutable(path: string): Promise<{
    readonly executable: boolean
    readonly native: boolean
  }>
  runCommand(
    file: string,
    args: readonly string[]
  ): Promise<BoundedCommandResult>
}

export interface RunnerPreflightResult {
  readonly config: RunnerConfig
  readonly skills: readonly ('weather' | 'obsidian' | 'image-generation')[]
  readonly blocked: readonly string[]
}

interface BoundedCommandStream {
  onData(listener: (chunk: object | string) => void): void
}

interface BoundedCommandChild {
  readonly stdout: BoundedCommandStream | null
  readonly stderr: BoundedCommandStream | null
  onExit(
    listener: (code: number | null, signal: string | null) => void
  ): void
  onError(listener: (error: Error) => void): void
  kill(signal: 'SIGTERM' | 'SIGKILL'): void
}

export interface BoundedCommandResult {
  readonly exitCode: number
  readonly stdout: string
  readonly stderr: string
  readonly timedOut: boolean
  readonly confirmedExit: boolean
}

export function runBoundedCommand(input: {
  readonly file: string
  readonly args: readonly string[]
  readonly timeoutMs: number
  readonly terminationGraceMs: number
  readonly outputLimit: number
  spawn(file: string, args: readonly string[]): BoundedCommandChild
}): Promise<BoundedCommandResult> {
  return new Promise((resolve) => {
    let stdout = ''
    let stderr = ''
    let settled = false
    let timedOut = false
    let timeout: ReturnType<typeof setTimeout> | undefined
    let force: ReturnType<typeof setTimeout> | undefined
    let confirmation: ReturnType<typeof setTimeout> | undefined

    const finish = (
      exitCode: number,
      confirmedExit: boolean,
      signal?: string | null
    ) => {
      if (settled) return
      settled = true
      if (timeout) clearTimeout(timeout)
      if (force) clearTimeout(force)
      if (confirmation) clearTimeout(confirmation)
      resolve({
        exitCode,
        stdout,
        stderr: signal
          ? appendBounded(stderr, `terminated by ${signal}`, input.outputLimit)
          : stderr,
        timedOut,
        confirmedExit
      })
    }

    let child: BoundedCommandChild
    try {
      child = input.spawn(input.file, input.args)
    } catch {
      finish(127, true)
      return
    }
    child.stdout?.onData((chunk) => {
      stdout = appendBounded(stdout, String(chunk), input.outputLimit)
    })
    child.stderr?.onData((chunk) => {
      stderr = appendBounded(stderr, String(chunk), input.outputLimit)
    })
    child.onError(() => finish(127, true))
    child.onExit((code, signal) => {
      finish(code ?? 128, true, signal)
    })
    timeout = setTimeout(() => {
      if (settled) return
      timedOut = true
      signalBoundedChild(child, 'SIGTERM')
      force = setTimeout(() => {
        if (settled) return
        signalBoundedChild(child, 'SIGKILL')
        confirmation = setTimeout(() => {
          finish(124, false)
        }, input.terminationGraceMs)
      }, input.terminationGraceMs)
    }, input.timeoutMs)
  })
}

export interface RunnerEvent {
  readonly type: string
  readonly elapsedMs: number
  readonly runId?: string
  readonly traceId?: string
  readonly agentId?: string
  readonly toolId?: string
  readonly tool?: string
  readonly generation?: number
  readonly processId?: number
  readonly code?: number | null
  readonly signal?: string | null
  readonly expected?: boolean
  readonly result?: HarnessJsonValue
  readonly message?: string
  readonly durationMs?: number
}

export function serializePublicRunnerEvent(
  event: RunnerEvent,
  sensitiveValues: readonly string[] = []
) {
  const output: Record<string, HarnessJsonValue> = {
    type: publicEventType(event.type),
    elapsedMs: finiteNumber(event.elapsedMs)
  }
  addIdentifier(output, 'runId', event.runId)
  addIdentifier(output, 'traceId', event.traceId)
  addIdentifier(output, 'agentId', event.agentId)
  addIdentifier(output, 'toolId', event.toolId)

  switch (event.type) {
    case 'sandbox-started':
      addNumber(output, 'generation', event.generation)
      addNumber(output, 'processId', event.processId)
      break
    case 'sandbox-exit':
      addNumber(output, 'generation', event.generation)
      if (event.code === null || typeof event.code === 'number') {
        output.code = event.code
      }
      if (event.signal === null || typeof event.signal === 'string') {
        output.signal = event.signal
      }
      if (typeof event.expected === 'boolean') output.expected = event.expected
      break
    case 'model-loaded':
    case 'shutdown':
      addNumber(output, 'durationMs', event.durationMs)
      break
    case 'tool-call':
      addTool(output, event.tool)
      break
    case 'tool-progress':
      addTool(output, event.tool)
      addNumber(output, 'durationMs', event.durationMs)
      output.result = publicProgress(event.result)
      break
    case 'tool-result':
      addTool(output, event.tool)
      addNumber(output, 'durationMs', event.durationMs)
      output.result = publicToolResult(event.tool, event.result)
      break
    case 'final-response':
      output.message = sanitizePublicText(
        event.message ?? '',
        sensitiveValues
      )
      break
    case 'run-error':
      output.message = 'agent run failed'
      break
    case 'runner-error':
      output.message = 'desktop runner failed'
      break
    case 'cleanup-error':
      output.message = sanitizePublicText(
        event.message ?? 'cleanup failed',
        sensitiveValues
      )
      break
    case 'run-cancelled':
      output.message = 'run cancelled'
      break
    case 'run-finished':
      if (
        event.message === 'success' ||
        event.message === 'failed' ||
        event.message === 'cancelled'
      ) {
        output.message = event.message
      }
      break
  }
  return JSON.stringify(output)
}

export function sanitizePublicText(
  value: string,
  sensitiveValues: readonly string[] = []
) {
  const fileUrlPlaceholder = '__QVAC_REDACTED_FILE_URL__'
  let sanitized = value.slice(0, 2_000)
  for (const sensitive of [...sensitiveValues].sort(
    (left, right) => right.length - left.length
  )) {
    if (sensitive.length >= 3) {
      sanitized = sanitized.split(sensitive).join('[redacted]')
    }
  }
  sanitized = sanitized.replace(
    /\bfile:\/\/\/[^\s"'`),\]]+/gi,
    fileUrlPlaceholder
  )
  sanitized = sanitized.replace(
    /\b\S*(?:secret|token|password|api[_-]?key)\S*\b/gi,
    '[redacted]'
  )
  sanitized = sanitized.replace(
    /\/(?:Users|private|var|tmp|home|opt|etc|usr|System|Applications|Volumes)(?:\/[^\s"'`),\]]*)?/g,
    '[redacted-path]'
  )
  sanitized = sanitized.replace(
    /(^|[\s"'`(=:])\/[^\s"'`),\]]+/g,
    '$1[redacted-path]'
  )
  return sanitized.replaceAll(fileUrlPlaceholder, 'file://[redacted-path]')
}

function publicToolResult(
  tool: string | undefined,
  result: HarnessJsonValue | undefined
): HarnessJsonValue {
  if (!isRecord(result)) return {}
  if (tool === 'http_request') {
    return {
      ...(typeof result.status === 'number'
        ? { status: result.status }
        : {}),
      ...(typeof result.body === 'string'
        ? { bodyBytes: result.body.length }
        : {}),
      ...(typeof result.error === 'string' ? { failed: true } : {})
    }
  }
  if (tool === 'exec') {
    return {
      ...(typeof result.exitCode === 'number'
        ? { exitCode: result.exitCode }
        : {}),
      ...(typeof result.error === 'string' ? { failed: true } : {})
    }
  }
  if (tool === 'generate_image') {
    const attachment = isRecord(result.attachment)
      ? result.attachment
      : undefined
    return {
      status: typeof result.status === 'string' ? result.status : 'unknown',
      ...(attachment
        ? {
            attachment: {
              ...(typeof attachment.id === 'string'
                ? { id: safeIdentifier(attachment.id) }
                : {}),
              ...(attachment.mimeType === 'image/png'
                ? { mimeType: 'image/png' }
                : {}),
              ...(typeof attachment.byteLength === 'number'
                ? { byteLength: finiteNumber(attachment.byteLength) }
                : {}),
              ...(typeof attachment.width === 'number'
                ? { width: finiteNumber(attachment.width) }
                : {}),
              ...(typeof attachment.height === 'number'
                ? { height: finiteNumber(attachment.height) }
                : {})
            }
          }
        : {}),
      ...(isRecord(result.stats)
        ? { stats: numericRecord(result.stats) }
        : {})
    }
  }
  return {}
}

function publicProgress(
  result: HarnessJsonValue | undefined
): HarnessJsonValue {
  if (!isRecord(result)) return {}
  return {
    ...(typeof result.step === 'number'
      ? { step: finiteNumber(result.step) }
      : {}),
    ...(typeof result.totalSteps === 'number'
      ? { totalSteps: finiteNumber(result.totalSteps) }
      : {}),
    ...(typeof result.elapsedMs === 'number'
      ? { elapsedMs: finiteNumber(result.elapsedMs) }
      : {})
  }
}

function publicEventType(type: string) {
  const allowed = new Set([
    'sandbox-started',
    'sandbox-exit',
    'run-started',
    'model-loaded',
    'tool-call',
    'tool-progress',
    'tool-result',
    'final-response',
    'run-error',
    'run-cancelled',
    'run-finished',
    'runner-error',
    'cleanup-error',
    'shutdown'
  ])
  return allowed.has(type) ? type : 'runner-event'
}

function addIdentifier(
  output: Record<string, HarnessJsonValue>,
  name: string,
  value: string | undefined
) {
  if (value) output[name] = safeIdentifier(value)
}

function safeIdentifier(value: string) {
  if (
    value.startsWith('/') ||
    value.length > 200 ||
    !/^[a-zA-Z0-9._:/-]+$/.test(value)
  ) {
    return '[redacted]'
  }
  return value
}

function addTool(
  output: Record<string, HarnessJsonValue>,
  tool: string | undefined
) {
  if (
    tool === 'http_request' ||
    tool === 'exec' ||
    tool === 'generate_image'
  ) {
    output.tool = tool
  }
}

function addNumber(
  output: Record<string, HarnessJsonValue>,
  name: string,
  value: number | undefined
) {
  if (typeof value === 'number') output[name] = finiteNumber(value)
}

function finiteNumber(value: number) {
  return Number.isFinite(value) ? value : 0
}

function signalBoundedChild(
  child: BoundedCommandChild,
  signal: 'SIGTERM' | 'SIGKILL'
) {
  try {
    child.kill(signal)
  } catch {
    // Exit confirmation still decides the result.
  }
}

function appendBounded(current: string, next: string, limit: number) {
  if (current.length >= limit) return current
  return (current + next).slice(0, limit)
}

export interface DesktopRunnerDependencies {
  createHarness(config: RunnerConfig): Promise<Pick<
    HarnessRuntime,
    'registerAgent' | 'runAgent' | 'close'
  >>
  readonly now?: () => number
  readonly cleanupTimeoutMs?: number
  readonly cancellationTimeoutMs?: number
}

export interface ProductionRunnerFactories {
  readonly createHarness: typeof createHarness
}

export interface DesktopCliInput {
  readonly argv: readonly string[]
  readonly environment: Readonly<Record<string, string | undefined>>
  readonly signal: HarnessAbortSignal
  writeJson(line: string): void
  writeHuman(line: string): void
}

export interface DesktopCliDependencies {
  readonly preflight: RunnerPreflightPort
  readonly runner: DesktopRunnerDependencies
}

export interface DesktopRunnerResult {
  readonly status: 'success' | 'failed' | 'cancelled' | 'partial'
  readonly runs: readonly {
    readonly skill: 'weather' | 'obsidian' | 'image-generation'
    readonly status: 'success' | 'failed' | 'cancelled'
  }[]
  readonly blocked: readonly string[]
  readonly attachment?: {
    readonly id: string
    readonly path: string
    readonly mimeType: string
    readonly byteLength: number
    readonly width: number
    readonly height: number
  }
  readonly shutdownMs: number
}

export function createProductionRunnerDependencies(
  factories: ProductionRunnerFactories = {
    createHarness
  }
): DesktopRunnerDependencies {
  return {
    async createHarness(config) {
      const bareExecutable = config.bareExecutable
      if (!bareExecutable) {
        throw new Error('Bare executable is unavailable after preflight')
      }
      const harness = factories.createHarness({
        inference: 'qwen',
        desktop: {
          bareExecutable,
          obsidianApproval: config.obsidianApproval,
          ...(config.obsidian
            ? {
                obsidian: {
                  ...config.obsidian,
                  access: RUNNER_OBSIDIAN_ACCESS,
                  allowedOperations: RUNNER_OBSIDIAN_OPERATIONS
                }
              }
            : {}),
          ...(config.attachmentBase && config.diffusion
            ? {
                image: {
                  attachmentRoot: config.attachmentBase,
                  model: config.diffusion.model,
                  ...(config.diffusion.prediction
                    ? { prediction: config.diffusion.prediction }
                    : {})
                }
              }
            : {}),
          weather: {}
        }
      })
      await harness.ready()
      return harness
    }
  }
}

export function createSmokeRunnerDependencies(): DesktopRunnerDependencies {
  return {
    async createHarness() {
      const registrations = new Map<string, HarnessAgentRegistration>()
      return {
        async registerAgent(registration) {
          registrations.set(registration.id, registration)
        },
        async *runAgent({ agentId, runId, signal }): AsyncGenerator<HarnessEvent> {
          const skill = registrations.get(agentId)?.skills[0]
          if (signal?.aborted) {
            yield { type: 'aborted' as const }
            return
          }
          if (skill === 'weather') {
            yield { type: 'tool-call' as const, name: 'http_request', args: {} }
            yield {
              type: 'tool-result' as const,
              name: 'http_request',
              result: { status: 200, body: 'London: +20 C' }
            }
            yield { type: 'content' as const, text: 'London: +20 C' }
          } else if (skill === 'obsidian') {
            yield { type: 'tool-call' as const, name: 'exec', args: {} }
            yield {
              type: 'tool-result' as const,
              name: 'exec',
              result: { exitCode: 0, stdout: 'smoke-note.md\n', stderr: '' }
            }
            yield { type: 'content' as const, text: 'smoke-note.md' }
          } else if (skill === 'image-generation') {
            yield {
              type: 'tool-call' as const,
              name: 'generate_image',
              args: {}
            }
            yield {
              type: 'tool-result' as const,
              name: 'generate_image',
              result: {
                status: 'success',
                attachment: {
                  id: 'smoke-image',
                  path: 'smoke://attachment/image.png',
                  mimeType: 'image/png',
                  byteLength: 67,
                  width: 512,
                  height: 512
                }
              }
            }
            yield { type: 'content' as const, text: `smoke:${runId}` }
          }
        },
        async close() {
        }
      }
    },
    now: deterministicClock()
  }
}

export async function executeDesktopCli(
  input: DesktopCliInput,
  dependencies: DesktopCliDependencies
): Promise<{
  readonly exitCode: number
  readonly result: DesktopRunnerResult
}> {
  const parsed = parseRunnerConfig(input.argv, input.environment)
  const config = parsed.command === 'smoke'
    ? {
        ...parsed,
        qwenModel: 'deterministic://qwen',
          attachmentBase: 'smoke://attachments',
        obsidianApproval: true
      }
    : parsed
  const preflight = await preflightRunner(config, dependencies.preflight)
  const sensitiveValues = runnerSensitiveValues(
    preflight.config,
    input.environment
  )
  const controller = new AbortController()
  const abort = () => controller.abort(
    typeof input.signal.reason === 'string'
      ? input.signal.reason
      : 'desktop runner interrupted'
  )
  if (input.signal.aborted) abort()
  else input.signal.addEventListener('abort', abort, { once: true })
  const timeout = setTimeout(
    () => controller.abort(`desktop runner exceeded ${config.timeoutMs} ms`),
    config.timeoutMs
  )

  try {
    const result = await runDesktopRunner(
      preflight,
      {
        signal: controller.signal,
        async emit(event) {
          input.writeJson(
            serializePublicRunnerEvent(event, sensitiveValues)
          )
        }
      },
      dependencies.runner
    )
    input.writeHuman(formatHumanResult(config.command, result))
    return {
      exitCode: exitCodeFor(result.status),
      result
    }
  } finally {
    clearTimeout(timeout)
    input.signal.removeEventListener('abort', abort)
  }
}

function runnerSensitiveValues(
  config: RunnerConfig,
  environment: Readonly<Record<string, string | undefined>>
) {
  return [
    config.qwenModel,
    config.diffusion?.model,
    config.attachmentBase,
    config.bareExecutable,
    config.obsidian?.executablePath,
    config.obsidian?.vaultRoot,
    config.obsidian?.vaultIdentity,
    ...Object.entries(environment)
      .filter(([name]) => /secret|token|password|key/i.test(name))
      .map(([, value]) => value)
  ].filter((value): value is string => typeof value === 'string' && value !== '')
}

export async function runDesktopRunner(
  preflight: RunnerPreflightResult,
  options: {
    readonly signal: HarnessAbortSignal
    readonly emit: (event: RunnerEvent) => Promise<void>
  },
  dependencies: DesktopRunnerDependencies
): Promise<DesktopRunnerResult> {
  const now = dependencies.now ?? Date.now
  const startedAt = now()
  const emit = async (
    event: Omit<RunnerEvent, 'elapsedMs'>
  ) => {
    await options.emit({
      ...event,
      elapsedMs: Math.max(0, now() - startedAt)
    })
  }
  let harness: Awaited<ReturnType<DesktopRunnerDependencies['createHarness']>> | undefined
  let attachment: DesktopRunnerResult['attachment']
  const runs: Array<DesktopRunnerResult['runs'][number]> = []
  let runStatus: DesktopRunnerResult['status'] = 'failed'
  let shutdownMs = 0

  try {
    const registrations = registrationsFor(
      preflight.config,
      preflight.skills
    )
    harness = await dependencies.createHarness(preflight.config)
    for (const registration of registrations) {
      await harness.registerAgent(registration)
    }

    for (let index = 0; index < registrations.length; index++) {
      const registration = registrations[index]
      if (!registration) continue
      const skill = registration.skills[0]
      if (!isSelectedSkill(skill)) continue
      if (options.signal.aborted) {
        runs.push({ skill, status: 'cancelled' })
        continue
      }
      const runId = `desktop-${index + 1}-${skill}`
      let acceptingRunEvents = true
      const pendingRun = runRegisteredAgent({
        harness,
        registration,
        skill,
        runId,
        signal: options.signal,
        async emitRunEvent(event) {
          if (acceptingRunEvents) await emit(event)
        },
        now,
        onAttachment(value) {
          attachment = value
        }
      })
      const outcome = await boundedRunAfterCancellation(
        pendingRun,
        options.signal,
        dependencies.cancellationTimeoutMs ??
          DEFAULT_CANCELLATION_TIMEOUT_MS
      )
      acceptingRunEvents = false
      const run = outcome.timedOut
        ? { skill, status: 'cancelled' as const }
        : outcome.value
      if (outcome.timedOut) {
        await emit({
          type: 'run-cancelled',
          runId,
          agentId: registration.id,
          message: 'cancellation timed out'
        })
      }
      runs.push(run)
      if (run.status === 'cancelled') break
    }

    runStatus = aggregateRunStatus(runs, preflight.blocked)
  } catch (error) {
    await emit({
      type: 'runner-error',
      message: humanError(error, 'desktop runner failed')
    })
    runStatus = options.signal.aborted ? 'cancelled' : 'failed'
  } finally {
    const shutdownStartedAt = now()
    const cleanupErrors: string[] = []
    const cleanupTimeoutMs =
      dependencies.cleanupTimeoutMs ?? DEFAULT_CLEANUP_TIMEOUT_MS
    const cleanupPhases: Array<{
      readonly name: string
      readonly close: () => Promise<void>
    }> = []
    if (harness) {
      const resource = harness
      cleanupPhases.push({ name: 'harness', close: () => resource.close() })
    }
    for (const phase of cleanupPhases) {
      const failure = await boundedCleanupPhase(
        phase.name,
        phase.close,
        cleanupTimeoutMs
      )
      if (failure) cleanupErrors.push(failure)
    }
    if (cleanupErrors.length > 0) {
      runStatus = 'failed'
      await emit({
        type: 'cleanup-error',
        message: `cleanup failed: ${cleanupErrors.join('; ')}`
      })
    }
    shutdownMs = Math.max(0, now() - shutdownStartedAt)
    await emit({ type: 'shutdown', durationMs: shutdownMs })
  }

  return {
    status: runStatus,
    runs,
    blocked: preflight.blocked,
    ...(attachment ? { attachment } : {}),
    shutdownMs
  }
}

async function boundedCleanupPhase(
  name: string,
  close: () => Promise<void>,
  timeoutMs: number
) {
  let timeout: ReturnType<typeof setTimeout> | undefined
  const outcome = await Promise.race([
    Promise.resolve()
      .then(close)
      .then(
        () => ({ status: 'success' as const }),
        () => ({ status: 'failed' as const })
      ),
    new Promise<{ readonly status: 'timed-out' }>((resolve) => {
      timeout = setTimeout(
        () => resolve({ status: 'timed-out' }),
        timeoutMs
      )
    })
  ])
  if (timeout) clearTimeout(timeout)
  if (outcome.status === 'success') return undefined
  return outcome.status === 'timed-out'
    ? `${name} timed out`
    : `${name} failed`
}

async function boundedRunAfterCancellation<T>(
  pending: Promise<T>,
  signal: HarnessAbortSignal,
  timeoutMs: number
): Promise<
  | { readonly timedOut: false; readonly value: T }
  | { readonly timedOut: true }
> {
  let timeout: ReturnType<typeof setTimeout> | undefined
  let onAbort: (() => void) | undefined
  const cancellation = new Promise<{ readonly timedOut: true }>((resolve) => {
    onAbort = () => {
      timeout = setTimeout(() => resolve({ timedOut: true }), timeoutMs)
    }
    if (signal.aborted) onAbort()
    else signal.addEventListener('abort', onAbort, { once: true })
  })
  const outcome = await Promise.race([
    pending.then((value) => ({ timedOut: false as const, value })),
    cancellation
  ])
  if (timeout) clearTimeout(timeout)
  if (onAbort) signal.removeEventListener('abort', onAbort)
  return outcome
}

function registrationsFor(
  config: RunnerConfig,
  skills: RunnerPreflightResult['skills']
): HarnessAgentRegistration[] {
  const model = config.qwenModel
  if (!model) throw new Error('Qwen model is unavailable after preflight')
  return skills.map((skill) => {
    const toolName = toolForSkill(skill)
    return {
      id: `${skill}-agent`,
      model,
      instructions: [
        selectedSkillInstructions(skill),
        'Use the selected tool when required, then answer concisely from its result.'
      ].join('\n\n'),
      skills: [skill],
      toolPolicy: {
        allow: [toolName],
        requireApproval: skill === 'obsidian' ? [toolName] : []
      }
    }
  })
}

async function runRegisteredAgent(input: {
  readonly harness: Pick<HarnessRuntime, 'runAgent'>
  readonly registration: HarnessAgentRegistration
  readonly skill: 'weather' | 'obsidian' | 'image-generation'
  readonly runId: string
  readonly signal: HarnessAbortSignal
  readonly emitRunEvent: (
    event: Omit<RunnerEvent, 'elapsedMs'>
  ) => Promise<void>
  readonly now: () => number
  readonly onAttachment: (
    attachment: NonNullable<DesktopRunnerResult['attachment']>
  ) => void
}): Promise<DesktopRunnerResult['runs'][number]> {
  const agentId = input.registration.id
  let toolSequence = 0
  let activeToolId: string | undefined
  let activeToolStartedAt: number | undefined
  let failed = false
  let cancelled = false
  let finalResponse = ''
  await input.emitRunEvent({
    type: 'run-started',
    runId: input.runId,
    agentId
  })
  for await (const event of input.harness.runAgent({
    agentId,
    runId: input.runId,
    input: promptForSkill(input.skill),
    signal: input.signal
  })) {
    if (event.type === 'tool-call') {
      toolSequence++
      activeToolId = `${input.runId}/tool/${toolSequence}`
      await input.emitRunEvent({
        type: 'tool-call',
        runId: input.runId,
        agentId,
        toolId: activeToolId,
        tool: event.name
      })
      activeToolStartedAt = input.now()
      continue
    }
    if (event.type === 'tool-progress') {
      await input.emitRunEvent({
        type: 'tool-progress',
        runId: input.runId,
        agentId,
        ...(activeToolId ? { toolId: activeToolId } : {}),
        tool: event.name,
        result: {
          step: event.progress.step,
          totalSteps: event.progress.totalSteps,
          elapsedMs: event.progress.elapsedMs
        }
      })
      continue
    }
    if (event.type === 'tool-result') {
      const durationMs = activeToolStartedAt === undefined
        ? undefined
        : Math.max(0, input.now() - activeToolStartedAt)
      const safeResult = safeToolResult(event)
      const foundAttachment = attachmentFromResult(safeResult)
      if (foundAttachment) input.onAttachment(foundAttachment)
      await input.emitRunEvent({
        type: 'tool-result',
        runId: input.runId,
        agentId,
        ...(activeToolId ? { toolId: activeToolId } : {}),
        tool: event.name,
        ...(durationMs === undefined ? {} : { durationMs }),
        result: safeResult
      })
      activeToolId = undefined
      activeToolStartedAt = undefined
      continue
    }
    if (event.type === 'content') {
      if (finalResponse.length < 2_000) {
        finalResponse = (finalResponse + event.text).slice(0, 2_000)
      }
      continue
    }
    if (event.type === 'error') {
      failed = true
      const detail = event.message.slice(0, 500)
      console.error(`run-error detail: ${sanitizePublicText(detail)}`)
      await input.emitRunEvent({
        type: 'run-error',
        runId: input.runId,
        agentId,
        message: detail
      })
      continue
    }
    if (event.type === 'aborted') {
      cancelled = true
      await input.emitRunEvent({
        type: 'run-cancelled',
        runId: input.runId,
        agentId
      })
    }
  }
  if (finalResponse && !failed && !cancelled && !input.signal.aborted) {
    await input.emitRunEvent({
      type: 'final-response',
      runId: input.runId,
      agentId,
      message: finalResponse
    })
  }
  const status = cancelled || input.signal.aborted
    ? 'cancelled'
    : failed
      ? 'failed'
      : 'success'
  await input.emitRunEvent({
    type: 'run-finished',
    runId: input.runId,
    agentId,
    message: status
  })
  return { skill: input.skill, status }
}

function selectedSkillInstructions(
  skill: 'weather' | 'obsidian' | 'image-generation'
) {
  return `Follow the selected ${skill} skill instructions exactly.`
}

function promptForSkill(
  skill: 'weather' | 'obsidian' | 'image-generation'
) {
  switch (skill) {
    case 'weather':
      return 'Use http_request to get the current weather in London from wttr.in with format=3, then summarize it.'
    case 'obsidian':
      return 'Use the Obsidian CLI to list files in the configured vault. Perform only this read-only operation.'
    case 'image-generation':
      return 'Use generate_image to make a 512x512 minimalist illustration of a small red sailboat on a calm blue lake. Use 1 step and seed 424242.'
  }
}

function toolForSkill(
  skill: 'weather' | 'obsidian' | 'image-generation'
) {
  switch (skill) {
    case 'weather':
      return 'http_request'
    case 'obsidian':
      return 'exec'
    case 'image-generation':
      return 'generate_image'
  }
}

function safeToolResult(event: Extract<HarnessEvent, { type: 'tool-result' }>) {
  if (!isRecord(event.result)) return event.result
  if (event.name === 'generate_image') {
    const attachment = isRecord(event.result.attachment)
      ? boundedAttachment(event.result.attachment)
      : undefined
    return {
      status:
        typeof event.result.status === 'string'
          ? event.result.status
          : 'unknown',
      ...(attachment ? { attachment } : {}),
      ...(isRecord(event.result.stats)
        ? { stats: numericRecord(event.result.stats) }
        : {})
    }
  }
  if (event.name === 'http_request') {
    return {
      ...(typeof event.result.status === 'number'
        ? { status: event.result.status }
        : {}),
      ...(typeof event.result.body === 'string'
        ? { body: event.result.body.slice(0, 8_192) }
        : {}),
      ...(typeof event.result.error === 'string'
        ? { error: event.result.error.slice(0, 500) }
        : {})
    }
  }
  return {
    ...(typeof event.result.exitCode === 'number'
      ? { exitCode: event.result.exitCode }
      : {}),
    ...(typeof event.result.stdout === 'string'
      ? { stdout: event.result.stdout.slice(0, 8_192) }
      : {}),
    ...(typeof event.result.stderr === 'string'
      ? { stderr: event.result.stderr.slice(0, 8_192) }
      : {}),
    ...(typeof event.result.error === 'string'
      ? { error: event.result.error.slice(0, 500) }
      : {})
  }
}

function attachmentFromResult(
  result: HarnessJsonValue
): DesktopRunnerResult['attachment'] | undefined {
  if (!isRecord(result) || !isRecord(result.attachment)) return undefined
  return boundedAttachment(result.attachment)
}

function boundedAttachment(
  value: Readonly<Record<string, HarnessJsonValue>>
): NonNullable<DesktopRunnerResult['attachment']> | undefined {
  if (
    typeof value.id !== 'string' ||
    typeof value.path !== 'string' ||
    value.mimeType !== 'image/png' ||
    typeof value.byteLength !== 'number' ||
    typeof value.width !== 'number' ||
    typeof value.height !== 'number'
  ) {
    return undefined
  }
  return {
    id: value.id,
    path: value.path,
    mimeType: value.mimeType,
    byteLength: value.byteLength,
    width: value.width,
    height: value.height
  }
}

function numericRecord(
  value: Readonly<Record<string, HarnessJsonValue>>
) {
  return Object.fromEntries(
    Object.entries(value).filter(
      (entry): entry is [string, number] =>
        typeof entry[1] === 'number' && Number.isFinite(entry[1])
    )
  )
}

function aggregateRunStatus(
  runs: DesktopRunnerResult['runs'],
  blocked: readonly string[]
): DesktopRunnerResult['status'] {
  if (runs.some((run) => run.status === 'cancelled')) return 'cancelled'
  if (runs.some((run) => run.status === 'failed')) return 'failed'
  if (blocked.length > 0) return 'partial'
  return runs.length > 0 ? 'success' : 'failed'
}

function isSelectedSkill(
  value: string | undefined
): value is 'weather' | 'obsidian' | 'image-generation' {
  return (
    value === 'weather' ||
    value === 'obsidian' ||
    value === 'image-generation'
  )
}

function isRecord(
  value: HarnessJsonValue | undefined
): value is Readonly<Record<string, HarnessJsonValue>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function humanError(error: unknown, fallback: string) {
  return error instanceof Error && error.message
    ? error.message.slice(0, 500)
    : fallback
}

function formatHumanResult(
  command: RunnerCommand,
  result: DesktopRunnerResult
) {
  const selected = result.runs
    .map((run) => `${run.skill}: ${run.status}`)
    .join(', ')
  const blocked = result.blocked.length > 0
    ? `, ${result.blocked.length} blocked`
    : ''
  return `${selected || `${command}: ${result.status}`} (overall ${result.status}${blocked}, shutdown ${result.shutdownMs} ms)`
}

function exitCodeFor(status: DesktopRunnerResult['status']) {
  if (status === 'success') return 0
  if (status === 'cancelled') return 130
  if (status === 'partial') return 2
  return 1
}

function deterministicClock() {
  let value = 0
  return function now() {
    value += 5
    return value
  }
}

export async function preflightRunner(
  config: RunnerConfig,
  port: RunnerPreflightPort
): Promise<RunnerPreflightResult> {
  if (config.command === 'smoke') {
    return {
      config,
      skills: ['weather', 'obsidian', 'image-generation'],
      blocked: []
    }
  }
  if (port.platform !== 'darwin') {
    throw new Error('desktop skill runner requires macOS')
  }

  const requested = requestedSkills(config.command)
  const obsidianConfigured =
    config.obsidian !== undefined && config.obsidianApproval
  if (config.command === 'obsidian' && !obsidianConfigured) {
    throw new Error(
      'Obsidian requires the official CLI, vault root, exact vault identity, and explicit approval'
    )
  }
  let skills = requested.filter(
    (skill) => skill !== 'obsidian' || obsidianConfigured
  )
  let blocked =
    requested.includes('obsidian') && !obsidianConfigured
      ? [
          'Obsidian BLOCKED: configure the official CLI, vault root, exact vault identity, and explicit approval'
        ]
      : []

  const bareExecutable = await requiredCanonicalFile(
    port,
    config.bareExecutable,
    'Bare executable'
  )
  const bareInspection = await port.inspectExecutable(bareExecutable)
  if (!bareInspection.executable || !bareInspection.native) {
    throw new Error('Bare executable must be a native executable')
  }
  const bareProbe = await port.runCommand(
    bareExecutable,
    [port.bareProbeEntry]
  )
  if (
    bareProbe.timedOut ||
    !bareProbe.confirmedExit ||
    bareProbe.exitCode !== 0 ||
    bareProbe.stdout.trim() !== BARE_RUNTIME_PROBE_OUTPUT ||
    bareProbe.stderr.trim() !== ''
  ) {
    throw new Error('Bare executable runtime probe failed')
  }
  const qwenModel = await requiredCanonicalFile(
    port,
    config.qwenModel,
    'Qwen model'
  )

  let diffusion = config.diffusion
  let attachmentBase = config.attachmentBase
  if (skills.includes('image-generation')) {
    if (!diffusion) {
      throw new Error('image generation requires an explicit diffusion model')
    }
    const model = await requiredCanonicalFile(
      port,
      diffusion.model,
      'diffusion model'
    )
    diffusion = {
      model,
      ...(diffusion.prediction
        ? { prediction: diffusion.prediction }
        : {})
    }
    attachmentBase = await requiredCanonicalDirectory(
      port,
      attachmentBase,
      'attachment base'
    )
  }

  let obsidian = config.obsidian
  if (skills.includes('obsidian') && obsidian) {
    try {
      obsidian = await preflightObsidian(obsidian, port)
    } catch (error) {
      if (config.command === 'obsidian') throw error
      skills = skills.filter((skill) => skill !== 'obsidian')
      blocked = ['Obsidian BLOCKED: official CLI validation failed']
      obsidian = undefined
    }
  }

  const configWithoutObsidian = removeObsidianConfig(config)
  return {
    config: {
      ...configWithoutObsidian,
      qwenModel,
      bareExecutable,
      ...(diffusion ? { diffusion } : {}),
      ...(attachmentBase ? { attachmentBase } : {}),
      ...(obsidian && skills.includes('obsidian') ? { obsidian } : {})
    },
    skills,
    blocked
  }
}

function removeObsidianConfig(config: RunnerConfig): RunnerConfig {
  const {
    command,
    qwenModel,
    diffusion,
    attachmentBase,
    bareExecutable,
    obsidianApproval,
    timeoutMs
  } = config
  return {
    command,
    ...(qwenModel ? { qwenModel } : {}),
    ...(diffusion ? { diffusion } : {}),
    ...(attachmentBase ? { attachmentBase } : {}),
    ...(bareExecutable ? { bareExecutable } : {}),
    obsidianApproval,
    timeoutMs
  }
}

async function preflightObsidian(
  configured: NonNullable<RunnerConfig['obsidian']>,
  port: RunnerPreflightPort
) {
  const executablePath = await requiredCanonicalFile(
    port,
    configured.executablePath,
    'Obsidian CLI'
  )
  if (
    executablePath ===
    '/Applications/Obsidian.app/Contents/MacOS/Obsidian'
  ) {
    throw new Error(
      'Electron app binary is not an official registered Obsidian CLI'
    )
  }
  const executable = await port.inspectExecutable(executablePath)
  if (!executable.executable) {
    throw new Error('official Obsidian CLI must be executable')
  }
  const vaultRoot = await requiredCanonicalDirectory(
    port,
    configured.vaultRoot,
    'Obsidian vault root'
  )
  validateVaultIdentity(configured.vaultIdentity)

  const version = await checkedPreflightCommand(
    port,
    executablePath,
    ['version'],
    'official Obsidian CLI validation'
  )
  assertObsidianVersion(version.stdout)
  const vaultPrefix = `vault=${configured.vaultIdentity}`
  const name = await checkedPreflightCommand(
    port,
    executablePath,
    [vaultPrefix, 'vault', 'info=name'],
    'official Obsidian vault identity validation'
  )
  if (name.stdout.trim() !== configured.vaultIdentity) {
    throw new Error(
      'configured Obsidian vault identity does not match the official CLI'
    )
  }
  const pathResult = await checkedPreflightCommand(
    port,
    executablePath,
    [vaultPrefix, 'vault', 'info=path'],
    'official Obsidian vault path validation'
  )
  const reportedPath = pathResult.stdout.trim()
  if (!reportedPath.startsWith('/')) {
    throw new Error('official Obsidian vault path is invalid')
  }
  const canonicalReportedPath = await port.realpath(reportedPath)
  if (canonicalReportedPath !== vaultRoot) {
    throw new Error(
      'configured Obsidian vault root does not match the official CLI'
    )
  }
  return {
    executablePath,
    vaultRoot,
    vaultIdentity: configured.vaultIdentity
  }
}

async function checkedPreflightCommand(
  port: RunnerPreflightPort,
  file: string,
  args: readonly string[],
  label: string
) {
  const result = await port.runCommand(file, args)
  if (
    result.timedOut ||
    !result.confirmedExit ||
    result.exitCode !== 0
  ) {
    throw new Error(`${label} failed`)
  }
  return result
}

function requestedSkills(
  command: RunnerCommand
): ('weather' | 'obsidian' | 'image-generation')[] {
  switch (command) {
    case 'weather':
      return ['weather']
    case 'obsidian':
      return ['obsidian']
    case 'image':
      return ['image-generation']
    case 'all':
    case 'smoke':
      return ['weather', 'obsidian', 'image-generation']
  }
}

async function requiredCanonicalFile(
  port: RunnerPreflightPort,
  configured: string | undefined,
  label: string
) {
  if (!configured) throw new Error(`${label} path is required`)
  await requireKind(
    port,
    configured,
    'file',
    `${label} must be an existing file`
  )
  return port.realpath(configured)
}

async function requiredCanonicalDirectory(
  port: RunnerPreflightPort,
  configured: string | undefined,
  label: string
) {
  if (!configured) throw new Error(`${label} path is required`)
  await requireKind(
    port,
    configured,
    'directory',
    `${label} must be an existing directory`
  )
  return port.realpath(configured)
}

async function requireKind(
  port: RunnerPreflightPort,
  path: string,
  kind: 'file' | 'directory',
  message: string
) {
  if (await port.inspect(path) !== kind) throw new Error(message)
}

function validateVaultIdentity(identity: string) {
  if (
    !identity.trim() ||
    identity.includes('\0') ||
    identity.includes('\r') ||
    identity.includes('\n')
  ) {
    throw new Error(
      'Obsidian vault identity must be a non-empty single-line string'
    )
  }
}

function assertObsidianVersion(output: string) {
  const match = /(\d+)\.(\d+)\.(\d+)/.exec(output)
  if (!match) {
    throw new Error('Obsidian CLI version output did not contain a semantic version')
  }
  const version = [
    Number.parseInt(match[1] ?? '', 10),
    Number.parseInt(match[2] ?? '', 10),
    Number.parseInt(match[3] ?? '', 10)
  ]
  if (
    version.some(Number.isNaN) ||
    compareVersions(version, [1, 12, 7]) < 0
  ) {
    throw new Error('Obsidian CLI 1.12.7 or newer is required')
  }
}

function compareVersions(
  left: readonly number[],
  right: readonly number[]
) {
  for (let index = 0; index < 3; index++) {
    const difference = (left[index] ?? 0) - (right[index] ?? 0)
    if (difference !== 0) return difference
  }
  return 0
}

export function parseRunnerConfig(
  argv: readonly string[],
  environment: Readonly<Record<string, string | undefined>>
): RunnerConfig {
  const command = argv[0]
  if (!isRunnerCommand(command)) {
    throw new Error(
      `command must be one of: ${COMMANDS.join(', ')}`
    )
  }
  const flags = parseFlags(argv.slice(1))
  const qwenModel = value(
    flags,
    'qwen-model',
    environment.QVAC_QWEN_MODEL
  )
  const diffusionModel = value(
    flags,
    'diffusion-model',
    environment.QVAC_DIFFUSION_MODEL
  )
  const predictionValue = value(
    flags,
    'diffusion-prediction',
    environment.QVAC_DIFFUSION_PREDICTION
  )
  const prediction = parsePrediction(predictionValue)
  const attachmentBase = value(
    flags,
    'attachment-base',
    environment.QVAC_ATTACHMENT_BASE
  )
  const bareExecutable = value(
    flags,
    'bare',
    environment.QVAC_BARE_EXECUTABLE
  )
  const obsidianExecutable = value(
    flags,
    'obsidian-cli',
    environment.QVAC_OBSIDIAN_CLI
  )
  const obsidianVaultRoot = value(
    flags,
    'obsidian-vault-root',
    environment.QVAC_OBSIDIAN_VAULT_ROOT
  )
  const obsidianVaultIdentity = value(
    flags,
    'obsidian-vault',
    environment.QVAC_OBSIDIAN_VAULT
  )
  const approvalValue = value(
    flags,
    'approve-obsidian',
    environment.QVAC_APPROVE_OBSIDIAN
  )
  const timeoutValue = value(
    flags,
    'timeout-ms',
    environment.QVAC_RUN_TIMEOUT_MS
  )
  const timeoutMs = timeoutValue === undefined
    ? DEFAULT_TIMEOUT_MS
    : positiveInteger(timeoutValue, '--timeout-ms')

  const obsidian =
    obsidianExecutable && obsidianVaultRoot && obsidianVaultIdentity
      ? {
          executablePath: obsidianExecutable,
          vaultRoot: obsidianVaultRoot,
          vaultIdentity: obsidianVaultIdentity
        }
      : undefined

  return {
    command,
    ...(qwenModel ? { qwenModel } : {}),
    ...(diffusionModel
      ? {
          diffusion: {
            model: diffusionModel,
            ...(prediction ? { prediction } : {})
          }
        }
      : {}),
    ...(attachmentBase ? { attachmentBase } : {}),
    ...(bareExecutable ? { bareExecutable } : {}),
    ...(obsidian ? { obsidian } : {}),
    obsidianApproval: booleanValue(
      approvalValue,
      '--approve-obsidian'
    ),
    timeoutMs
  }
}

function parseFlags(argv: readonly string[]) {
  const flags = new Map<string, string>()
  for (let index = 0; index < argv.length; index++) {
    const raw = argv[index]
    if (!raw?.startsWith('--')) {
      throw new Error(`unexpected argument: ${raw ?? ''}`)
    }
    const equals = raw.indexOf('=')
    const name = raw.slice(2, equals >= 0 ? equals : undefined)
    if (!KNOWN_FLAGS.has(name)) throw new Error(`unknown option: --${name}`)
    if (flags.has(name)) throw new Error(`duplicate option: --${name}`)
    if (equals >= 0) {
      flags.set(name, raw.slice(equals + 1))
      continue
    }
    const next = argv[index + 1]
    if (name === 'approve-obsidian' && next?.startsWith('--')) {
      flags.set(name, 'true')
      continue
    }
    if (name === 'approve-obsidian' && next === undefined) {
      flags.set(name, 'true')
      continue
    }
    if (next === undefined || next.startsWith('--')) {
      throw new Error(`--${name} requires a value`)
    }
    flags.set(name, next)
    index++
  }
  return flags
}

function value(
  flags: ReadonlyMap<string, string>,
  name: string,
  environmentValue: string | undefined
) {
  const configured = flags.get(name) ?? environmentValue
  return configured?.trim() || undefined
}

function positiveInteger(raw: string, label: string) {
  const parsed = Number.parseInt(raw, 10)
  if (
    Number.isNaN(parsed) ||
    !Number.isSafeInteger(parsed) ||
    parsed < 1 ||
    String(parsed) !== raw
  ) {
    throw new Error(`${label} must be a positive integer`)
  }
  return parsed
}

function booleanValue(raw: string | undefined, label: string) {
  if (raw === undefined || raw === 'false' || raw === '0') return false
  if (raw === 'true' || raw === '1') return true
  throw new Error(`${label} must be true or false`)
}

function parsePrediction(
  value: string | undefined
): DiffusionPrediction | undefined {
  if (value === undefined) return undefined
  if (
    DIFFUSION_PREDICTIONS.includes(
      value as DiffusionPrediction
    )
  ) {
    return value as DiffusionPrediction
  }
  throw new Error(
    `--diffusion-prediction must be one of: ${DIFFUSION_PREDICTIONS.join(', ')}`
  )
}

function isRunnerCommand(
  value: string | undefined
): value is RunnerCommand {
  return COMMANDS.includes(value as RunnerCommand)
}

const KNOWN_FLAGS = new Set([
  'qwen-model',
  'diffusion-model',
  'diffusion-prediction',
  'attachment-base',
  'bare',
  'sandbox-entry',
  'obsidian-cli',
  'obsidian-vault-root',
  'obsidian-vault',
  'approve-obsidian',
  'timeout-ms'
])
