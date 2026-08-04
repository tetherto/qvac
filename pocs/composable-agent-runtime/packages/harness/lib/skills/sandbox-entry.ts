import process from '#process'
import type { HarnessStream } from '../transport.ts'
import { serveToolSandbox } from '../tool-sandbox/wire.ts'
import { createSkillSandboxExecutor, type SkillSandboxProvider } from './sandbox.ts'

export interface CreateToolSandboxChildEntryOptions {
  readonly skills: readonly SkillSandboxProvider[]
}

/**
 * Builds a sandbox worker entry from skill providers. Applications own the
 * entry module (the bundler follows static imports) but not the generation
 * handshake or serve plumbing, which must not drift from the host.
 */
export function createToolSandboxChildEntry({
  skills
}: CreateToolSandboxChildEntryOptions) {
  const generation = generationFromArgv()
  const configure = createSkillSandboxExecutor(skills)

  return async function start(stream: HarnessStream, ready?: () => void) {
    const server = serveToolSandbox(stream, {
      generation,
      processId: process.pid,
      configure
    })
    ready?.()
    return async function stop() {
      await server.close()
    }
  }
}

function generationFromArgv() {
  const value = process.argv
    .find((entry: string) => entry.startsWith('--sandbox-generation='))
    ?.slice('--sandbox-generation='.length)
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    throw new Error('tool sandbox requires a positive generation')
  }
  return parsed
}
