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
}

export interface ModelContentEvent {
  readonly type: 'content'
  readonly text: string
}

export interface ModelAdapter {
  stream(request: ModelRequest): AsyncIterable<ModelContentEvent>
  cancel?(operationId: string): Promise<void> | void
}

export interface AgentOutput {
  readonly operationId: string
  readonly output: string
}

export interface AgentCheckpoint {
  readonly version: 1
  readonly agentId: string
  readonly runId: string
  readonly nextOperationIndex: number
  readonly outputs: readonly AgentOutput[]
}

export interface WorkflowContext {
  readonly input: string
  readonly outputs: readonly AgentOutput[]
}

export interface AgentOperation {
  readonly id: string
  readonly prompt: string | ((context: WorkflowContext) => string)
}

export interface AgentDefinition {
  readonly id: string
  readonly model: string
  readonly instructions?: string
  readonly workflow?: readonly AgentOperation[]
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

export type AgentEvent =
  | RunStartedEvent
  | OperationStartedEvent
  | ContentEvent
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
