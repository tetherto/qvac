import type { HarnessStream } from '../../lib/transport.ts'

export type WireValue =
  | boolean
  | number
  | string
  | null
  | WireValue[]
  | { [key: string]: WireValue }

export interface GeneratedRunStream extends AsyncIterable<Record<string, WireValue>> {
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

export default class HarnessRPC {
  constructor(stream: HarnessStream)
  describeRuntime(
    input: Record<string, WireValue>
  ): Promise<Record<string, WireValue>>
  onDescribeRuntime(
    handler: (
      input: Record<string, WireValue>
    ) => Promise<Record<string, WireValue>> | Record<string, WireValue>
  ): void
  run(): GeneratedRunStream
  onRun(handler: (stream: GeneratedRunStream) => Promise<void> | void): void
}
