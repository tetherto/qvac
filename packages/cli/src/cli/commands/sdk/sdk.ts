import { spawn } from '#child_process'
import { fileURLToPath } from '#url'
import type { ChildProcess } from 'node:child_process'

// HTTP and SDK tooling remain Node-only. Both launchers use the packaged JS runner.
export function runSdk(
  { words }: { words: string[] },
  {
    node,
    supervise
  }: {
    node: string
    supervise(child: ChildProcess): void
  }
): void {
  const entry = fileURLToPath(new URL('../../sdk-entry.js', import.meta.url))
  supervise(spawn(node, [entry, ...words], { stdio: 'inherit' }))
}
