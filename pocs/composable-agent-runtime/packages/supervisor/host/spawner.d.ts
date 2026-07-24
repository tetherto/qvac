import type { RelayControl } from '../runner/relay.js'

export interface RelayChild {
  ipc: {
    on(event: 'data', listener: (chunk: Uint8Array) => void): unknown
    write(chunk: Uint8Array): unknown
    destroy(): unknown
  }
  exit: Promise<number>
}

declare function serveSpawner(
  control: RelayControl,
  spawn: (entry: string, args: string[]) => RelayChild
): () => void
export default serveSpawner
