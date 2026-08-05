import type { HarnessStream } from '../../lib/transport.ts'

export type WireValue =
  | boolean
  | number
  | string
  | null
  | WireValue[]
  | { [key: string]: WireValue }

export interface GeneratedHarnessStream extends AsyncIterable<Record<string, WireValue>> {
  on(event: 'data', listener: (frame: Record<string, WireValue>) => void): object
  on(event: 'error', listener: (error: Error) => void): object
  on(event: 'close' | 'end', listener: () => void): object
  write(frame: Record<string, WireValue>): boolean
  end(): void
  destroy(): void
  readStream?: {
    on(event: 'close', listener: () => void): object
  }
}

export type GeneratedRunStream = GeneratedHarnessStream

export default class HarnessRPC {
  constructor(stream: HarnessStream)
  describeRuntime(input: Record<string, WireValue>): Promise<Record<string, WireValue>>
  onDescribeRuntime(handler: (input: Record<string, WireValue>) => Promise<Record<string, WireValue>> | Record<string, WireValue>): void
  suspend(input: Record<string, WireValue>): Promise<Record<string, WireValue>>
  onSuspend(handler: (input: Record<string, WireValue>) => Promise<Record<string, WireValue>> | Record<string, WireValue>): void
  resume(input: Record<string, WireValue>): Promise<Record<string, WireValue>>
  onResume(handler: (input: Record<string, WireValue>) => Promise<Record<string, WireValue>> | Record<string, WireValue>): void
  run(input?: Record<string, WireValue>): GeneratedHarnessStream
  onRun(handler: (stream: GeneratedHarnessStream) => Promise<void> | void): void
  listSkills(input: Record<string, WireValue>): Promise<Record<string, WireValue>>
  onListSkills(handler: (input: Record<string, WireValue>) => Promise<Record<string, WireValue>> | Record<string, WireValue>): void
  registerAgent(input: Record<string, WireValue>): Promise<Record<string, WireValue>>
  onRegisterAgent(handler: (input: Record<string, WireValue>) => Promise<Record<string, WireValue>> | Record<string, WireValue>): void
  runAgent(input?: Record<string, WireValue>): GeneratedHarnessStream
  onRunAgent(handler: (stream: GeneratedHarnessStream) => Promise<void> | void): void
  cancelAgentRun(input: Record<string, WireValue>): Promise<Record<string, WireValue>>
  onCancelAgentRun(handler: (input: Record<string, WireValue>) => Promise<Record<string, WireValue>> | Record<string, WireValue>): void
  readRun(input: Record<string, WireValue>): Promise<Record<string, WireValue>>
  onReadRun(handler: (input: Record<string, WireValue>) => Promise<Record<string, WireValue>> | Record<string, WireValue>): void
  watchWork(input?: Record<string, WireValue>): GeneratedHarnessStream
  onWatchWork(handler: (stream: GeneratedHarnessStream) => Promise<void> | void): void
  statePort(input?: Record<string, WireValue>): GeneratedHarnessStream
  onStatePort(handler: (stream: GeneratedHarnessStream) => Promise<void> | void): void
  approvals(input?: Record<string, WireValue>): GeneratedHarnessStream
  onApprovals(handler: (stream: GeneratedHarnessStream) => Promise<void> | void): void
}
