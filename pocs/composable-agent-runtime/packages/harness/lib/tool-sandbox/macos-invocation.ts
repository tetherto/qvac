export interface MacOsSandboxExecInvocationOptions {
  readonly profilePath: string
  readonly scratchRoot: string
  readonly bareExecutable: string
  readonly childEntry: string
  readonly generation: number
}

export function buildMacOsSandboxExecInvocation({
  profilePath,
  scratchRoot,
  bareExecutable,
  childEntry,
  generation
}: MacOsSandboxExecInvocationOptions) {
  if (!Number.isSafeInteger(generation) || generation < 1) {
    throw new Error('sandbox generation must be a positive safe integer')
  }
  return {
    file: '/usr/bin/sandbox-exec',
    args: [
      '-f',
      profilePath,
      bareExecutable,
      childEntry,
      `--sandbox-generation=${generation}`
    ],
    options: {
      cwd: '/',
      env: {
        HOME: scratchRoot,
        LANG: 'C',
        PATH: '/usr/bin:/bin',
        TMPDIR: scratchRoot
      },
      shell: false as const,
      stdio: ['ignore', 'ignore', 'pipe', 'pipe'] as const
    }
  }
}
