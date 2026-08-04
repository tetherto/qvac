import fs from '#fs-promises'
import os from '#os'
import path from '#path'

export interface CreateSandboxArtifactsOptions {
  readonly temporaryRoot?: string
  readonly agentId: string
  readonly generation: number
  readonly profile:
    | string
    | ((paths: {
        readonly directory: string
        readonly scratchRoot: string
        readonly profilePath: string
      }) => string)
}

export interface SandboxArtifacts {
  readonly directory: string
  readonly scratchRoot: string
  readonly profilePath: string
  cleanup(): Promise<void>
}

export async function createSandboxArtifacts({
  temporaryRoot = os.tmpdir(),
  agentId,
  generation,
  profile
}: CreateSandboxArtifactsOptions): Promise<SandboxArtifacts> {
  validateGeneration(generation)
  const prefix = path.join(
    temporaryRoot,
    `qvac-tool-sandbox-${safeSegment(agentId)}-g${generation}-`
  )
  const directory = await fs.mkdtemp(prefix)
  const scratchRoot = path.join(directory, 'scratch')
  const profilePath = path.join(directory, 'seatbelt.sb')
  let cleaned = false
  let cleaning: Promise<void> | undefined

  try {
    await fs.chmod(directory, 0o700)
    await fs.mkdir(scratchRoot, { mode: 0o700 })
    await fs.chmod(scratchRoot, 0o700)
    const content =
      typeof profile === 'string'
        ? profile
        : profile({ directory, scratchRoot, profilePath })
    await fs.writeFile(profilePath, content, { mode: 0o600 })
    await fs.chmod(profilePath, 0o600)
  } catch (error) {
    await fs.rm(directory, { recursive: true, force: true })
    throw error
  }

  return {
    directory,
    scratchRoot,
    profilePath,
    async cleanup() {
      if (cleaned) return
      cleaning ??= fs
        .rm(directory, { recursive: true, force: true })
        .then(() => {
          cleaned = true
        })
        .finally(() => {
          cleaning = undefined
        })
      await cleaning
    }
  }
}

function safeSegment(value: string) {
  const segment = value.replaceAll(/[^a-zA-Z0-9_-]/g, '_').slice(0, 48)
  return segment || 'agent'
}

function validateGeneration(generation: number) {
  if (!Number.isSafeInteger(generation) || generation < 1) {
    throw new Error('sandbox generation must be a positive safe integer')
  }
}
