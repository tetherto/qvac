import type { HarnessJsonValue } from '../types.ts'

export interface ToolSandboxDescription {
  readonly component: 'tool-sandbox'
  readonly runtime: 'bare'
  readonly generation: number
  readonly processId: number
  readonly protocolVersion: number
}

export interface ToolSandboxInvokeRequest {
  readonly invocationId: string
  readonly generation: number
  readonly toolName: string
  readonly input: Readonly<Record<string, HarnessJsonValue>>
}

export interface ToolSandboxCancelRequest {
  readonly invocationId: string
  readonly generation: number
}

export interface ToolSandboxConfigureRequest {
  readonly generation: number
  readonly configuration: Readonly<Record<string, HarnessJsonValue>>
}

export type ToolSandboxResult =
  | {
      readonly status: 'success'
      readonly invocationId: string
      readonly generation: number
      readonly value: HarnessJsonValue
    }
  | {
      readonly status: 'error'
      readonly invocationId: string
      readonly generation: number
      readonly error: {
        readonly code: string
        readonly message: string
      }
    }

export interface ToolSandbox {
  ready(): Promise<ToolSandboxDescription>
  configure(input: ToolSandboxConfigureRequest): Promise<{
    readonly generation: number
  }>
  invoke(input: ToolSandboxInvokeRequest): Promise<ToolSandboxResult>
  cancel(input: ToolSandboxCancelRequest): Promise<void>
  close(): Promise<void>
}

export interface ToolSandboxProcessExit {
  readonly code: number | null
  readonly signal: string | null
}

export interface LaunchedToolSandbox {
  readonly agentId: string
  readonly generation: number
  readonly sandbox: ToolSandbox
  readonly exited: Promise<ToolSandboxProcessExit>
  cleanup(): Promise<void>
}

export interface ToolSandboxLauncher {
  launch(input: {
    readonly agentId: string
    readonly generation: number
  }): Promise<LaunchedToolSandbox>
}
