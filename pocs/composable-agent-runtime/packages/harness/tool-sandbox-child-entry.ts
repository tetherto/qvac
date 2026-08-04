import process from 'bare-process'
import type { HarnessStream } from './lib/transport.ts'
import { createSkillSandboxExecutor } from './lib/skills/sandbox.ts'
import { createObsidianSkillSandbox } from './lib/skills-impl/obsidian/sandbox.ts'
import { createWeatherSkillSandbox } from './lib/skills-impl/weather/sandbox.ts'
import { serveToolSandbox } from './lib/tool-sandbox/wire.ts'

const generation = generationFromArgv()

// The bundler follows static imports, so which skills a sandbox can serve is
// fixed by this entry rather than discovered at runtime.
const configure = createSkillSandboxExecutor([
  createWeatherSkillSandbox(),
  createObsidianSkillSandbox()
])

export default async function start(
  stream: HarnessStream,
  ready?: () => void
) {
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
