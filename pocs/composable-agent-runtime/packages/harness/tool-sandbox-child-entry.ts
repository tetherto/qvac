import process from 'bare-process'
import type { HarnessStream } from './lib/transport.ts'
import { createDesktopToolExecutor } from './lib/tool-sandbox/desktop-executor.ts'
import { serveToolSandbox } from './lib/tool-sandbox/wire.ts'

const generation = generationFromArgv()

export default async function start(
  stream: HarnessStream,
  ready?: () => void
) {
  const server = serveToolSandbox(stream, {
    generation,
    processId: process.pid,
    configure: createDesktopToolExecutor
  })
  ready?.()
  return async function stop() {
    await server.close()
  }
}

function generationFromArgv() {
  const value = process.argv
    .find((entry) => entry.startsWith('--sandbox-generation='))
    ?.slice('--sandbox-generation='.length)
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    throw new Error('tool sandbox requires a positive generation')
  }
  return parsed
}
