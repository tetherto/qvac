import type {
  AgentJsonValue,
  AgentToolCall,
  AgentToolPolicy,
  AgentToolProgress,
  AgentToolSchema,
  AgentToolingOptions
} from './tools.ts'

export interface AgentMessage {
  readonly role: 'system' | 'user' | 'assistant' | 'tool'
  readonly content: string
}

export interface AgentAbortSignal {
  readonly aborted: boolean
  readonly reason?: string
  addEventListener(type: 'abort', listener: () => void, options?: { readonly once?: boolean }): void
  removeEventListener(type: 'abort', listener: () => void): void
}

export interface ModelRequest {
  readonly model: string
  readonly messages: readonly AgentMessage[]
  readonly runId: string
  readonly operationId: string
  readonly signal: AgentAbortSignal
  /** Zero-based tool round within the current operation. */
  readonly round: number
  readonly tools?: readonly AgentToolSchema[]
}

export interface ModelContentEvent {
  readonly type: 'content'
  readonly text: string
}

export interface ModelToolCallEvent {
  readonly type: 'tool-call'
  readonly call: AgentToolCall
  /** Provider-native rendering of the call, when the provider supplies one. */
  readonly raw?: string
}

export interface ModelCompletionDoneEvent {
  readonly type: 'completion-done'
  /** Canonical assistant turn text, preferred over concatenated deltas. */
  readonly raw?: string
}

export type ModelEvent =
  | ModelContentEvent
  | ModelToolCallEvent
  | ModelCompletionDoneEvent

export interface ModelAdapter {
  stream(request: ModelRequest): AsyncIterable<ModelEvent>
  cancel?(operationId: string): Promise<void> | void
}

export interface AgentOutput {
  readonly operationId: string
  readonly output: string
}

/**
 * Mid-operation progress. Present only while an operation is suspended between
 * tool rounds; a checkpoint taken at an operation boundary omits it.
 */
export interface AgentOperationCheckpoint {
  readonly operationId: string
  readonly round: number
  readonly messages: readonly AgentMessage[]
}

export const CHECKPOINT_VERSION = 2

export interface AgentCheckpoint {
  readonly version: typeof CHECKPOINT_VERSION
  readonly agentId: string
  readonly runId: string
  readonly nextOperationIndex: number
  readonly outputs: readonly AgentOutput[]
  readonly operation?: AgentOperationCheckpoint
}

export interface WorkflowContext {
  readonly input: string
  readonly outputs: readonly AgentOutput[]
}

export interface AgentOperation {
  readonly id: string
  readonly prompt: string | ((context: WorkflowContext) => string)
}

/** An addressable block of system-prompt text, kept separate so callers can
 * compose instructions from several sources without string concatenation. */
export interface AgentPromptBlock {
  readonly id: string
  readonly text: string
}

export interface AgentDefinition {
  readonly id: string
  readonly model: string
  readonly instructions?: string
  readonly systemPrompt?: readonly AgentPromptBlock[]
  readonly workflow?: readonly AgentOperation[]
  readonly toolPolicy?: AgentToolPolicy
  /** Maximum tool rounds per operation. Defaults to DEFAULT_TURN_BUDGET. */
  readonly turnBudget?: number
}

interface RunStartedEvent {
  readonly type: 'run-started'
  readonly runId: string
}

interface OperationStartedEvent {
  readonly type: 'operation-started'
  readonly runId: string
  readonly operationId: string
}

interface ContentEvent {
  readonly type: 'content'
  readonly runId: string
  readonly operationId: string
  readonly text: string
}

interface OperationCompletedEvent {
  readonly type: 'operation-completed'
  readonly runId: string
  readonly operationId: string
  readonly output: string
}

interface CheckpointEvent {
  readonly type: 'checkpoint'
  readonly runId: string
  readonly operationId: string
  readonly checkpoint: AgentCheckpoint
}

interface RunCompletedEvent {
  readonly type: 'run-completed'
  readonly runId: string
  readonly output: string
  readonly checkpoint: AgentCheckpoint
}

interface RunCanceledEvent {
  readonly type: 'run-canceled'
  readonly runId: string
  readonly reason: string
  readonly checkpoint: AgentCheckpoint
}

interface ToolCallEvent {
  readonly type: 'tool-call'
  readonly runId: string
  readonly operationId: string
  readonly call: AgentToolCall
}

interface ToolResultEvent {
  readonly type: 'tool-result'
  readonly runId: string
  readonly operationId: string
  readonly callId: string
  readonly name: string
  readonly result: AgentJsonValue
}

interface ToolProgressEvent {
  readonly type: 'tool-progress'
  readonly runId: string
  readonly operationId: string
  readonly callId: string
  readonly name: string
  readonly progress: AgentToolProgress
}

interface ApprovalRequestedEvent {
  readonly type: 'approval-requested'
  readonly runId: string
  readonly operationId: string
  readonly callId: string
  readonly name: string
}

interface ApprovalResolvedEvent {
  readonly type: 'approval-resolved'
  readonly runId: string
  readonly operationId: string
  readonly callId: string
  readonly name: string
  readonly approved: boolean
}

/**
 * The operation stopped because it used its whole turn budget, not because the
 * model finished. Callers must be able to tell those apart.
 */
interface BudgetExhaustedEvent {
  readonly type: 'budget-exhausted'
  readonly runId: string
  readonly operationId: string
  readonly rounds: number
}

export type AgentEvent =
  | RunStartedEvent
  | OperationStartedEvent
  | ContentEvent
  | ToolCallEvent
  | ToolResultEvent
  | ToolProgressEvent
  | ApprovalRequestedEvent
  | ApprovalResolvedEvent
  | BudgetExhaustedEvent
  | OperationCompletedEvent
  | CheckpointEvent
  | RunCompletedEvent
  | RunCanceledEvent

export interface CompletedRunResult {
  readonly status: 'completed'
  readonly runId: string
  readonly output: string
  readonly checkpoint: AgentCheckpoint
}

export interface CanceledRunResult {
  readonly status: 'canceled'
  readonly runId: string
  readonly reason: string
  readonly checkpoint: AgentCheckpoint
}

export type AgentRunResult = CompletedRunResult | CanceledRunResult

export interface AgentRunOptions {
  readonly runId: string
  readonly input: string
  readonly adapter: ModelAdapter
  readonly checkpoint?: AgentCheckpoint
  readonly signal?: AgentAbortSignal
  readonly tooling?: AgentToolingOptions
}

export interface AgentRun {
  readonly events: AsyncIterable<AgentEvent>
  readonly result: Promise<AgentRunResult>
  cancel(reason?: string): Promise<void>
}

export interface DefinedAgent {
  readonly id: string
  readonly model: string
  run(options: AgentRunOptions): AgentRun
}
