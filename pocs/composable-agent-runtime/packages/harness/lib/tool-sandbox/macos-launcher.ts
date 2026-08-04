import fs from '#fs-promises'
import os from '#os'
import path from '#path'
import type { HarnessJsonValue } from '../types.ts'
import type { HarnessStream } from '../transport.ts'
import { createSandboxArtifacts } from './artifacts.ts'
import { connectToolSandbox } from './wire.ts'
import { buildMacOsSandboxExecInvocation } from './macos-invocation.ts'
import {
  createMacOsSandboxPolicy,
  renderSeatbeltProfile
} from './profile.ts'
import type {
  LaunchedToolSandbox,
  ToolSandboxLauncher,
  ToolSandboxProcessExit
} from './types.ts'

interface DiagnosticStream {
  on(event: 'data', listener: (data: Uint8Array) => void): object
}

interface SpawnedSandboxProcess {
  readonly stdio: readonly (HarnessStream | DiagnosticStream | null)[]
  once(
    event: 'exit',
    listener: (code: number | null, signal: string | null) => void
  ): object
  kill(signal?: number): void
}

interface SandboxSpawnOptions {
  readonly cwd: string
  readonly env: Record<string, string>
  readonly shell: false
  readonly stdio: readonly ['ignore', 'ignore', 'pipe', 'pipe']
}

interface SandboxIpc extends HarnessStream {
  readonly ready: Promise<void>
  terminate(): Promise<number | undefined>
}

type SandboxSpawn = (
  file: string,
  args: readonly string[],
  options: SandboxSpawnOptions
) => SpawnedSandboxProcess

type SandboxWrap = (stream: HarnessStream) => SandboxIpc

export interface CreateMacOsToolSandboxLauncherOptions {
  readonly bareExecutable: string
  readonly childEntry: string
  readonly codeRoots?: readonly string[]
  readonly resourceRootsForAgent?: (
    agentId: string
  ) => readonly string[] | Promise<readonly string[]>
  readonly executablePaths: readonly string[]
  readonly readOnlyRoots: readonly string[]
  readonly writeRoots: readonly string[]
  readonly permissionsForAgent?: (
    agentId: string
  ) =>
    | ToolSandboxAgentPermissions
    | Promise<ToolSandboxAgentPermissions>
  readonly temporaryRoot?: string
  readonly spawn?: SandboxSpawn
  readonly wrap?: SandboxWrap
}

export interface ToolSandboxAgentPermissions {
  readonly resourceRoots?: readonly string[]
  readonly executablePaths?: readonly string[]
  readonly readOnlyRoots?: readonly string[]
  readonly writeRoots?: readonly string[]
  readonly loopbackPorts?: readonly number[]
  readonly unixSocketPaths?: readonly string[]
  readonly configuration?:
    | Readonly<Record<string, HarnessJsonValue>>
    | ((paths: {
        readonly scratchRoot: string
      }) => Readonly<Record<string, HarnessJsonValue>>)
}

export function createMacOsToolSandboxLauncher(
  options: CreateMacOsToolSandboxLauncherOptions
): ToolSandboxLauncher {
  const executablePaths = [...options.executablePaths]
  const codeRoots = [...(options.codeRoots ?? [])]
  const readOnlyRoots = [...options.readOnlyRoots]
  const writeRoots = [...options.writeRoots]
  let canonicalPromise:
    | Promise<{
        bareExecutable: string
        childEntry: string
        executablePaths: string[]
        codeRoots: string[]
        readOnlyRoots: string[]
        writeRoots: string[]
        temporaryRoot: string
      }>
    | undefined

  return {
    async launch({ agentId, generation }): Promise<LaunchedToolSandbox> {
      canonicalPromise ??= canonicalConfiguration()
      const canonical = await canonicalPromise
      const permissions = await options.permissionsForAgent?.(agentId) ?? {}
      const [
        resourceRoots,
        agentExecutablePaths,
        agentReadOnlyRoots,
        agentWriteRoots,
        agentUnixSocketPaths
      ] = await Promise.all([
        canonicalPaths([
          ...(await options.resourceRootsForAgent?.(agentId) ?? []),
          ...(permissions.resourceRoots ?? [])
        ]),
        canonicalPaths(permissions.executablePaths ?? []),
        canonicalPaths(permissions.readOnlyRoots ?? []),
        canonicalPaths(permissions.writeRoots ?? []),
        optionalCanonicalPaths(permissions.unixSocketPaths ?? [])
      ])
      const executablePaths = sortedUnique([
        ...canonical.executablePaths,
        ...agentExecutablePaths
      ])
      const readOnlyRoots = sortedUnique([
        ...canonical.readOnlyRoots,
        ...agentReadOnlyRoots
      ])
      const writeRoots = sortedUnique([
        ...canonical.writeRoots,
        ...agentWriteRoots
      ])
      const unixSocketPaths = sortedUnique(agentUnixSocketPaths)
      const wrap = options.wrap ?? (await loadWrap())
      const artifacts = await createSandboxArtifacts({
        temporaryRoot: canonical.temporaryRoot,
        agentId,
        generation,
        profile: ({ scratchRoot }) =>
          renderSeatbeltProfile(
            createMacOsSandboxPolicy({
              bareExecutable: canonical.bareExecutable,
              childEntry: canonical.childEntry,
              codeRoots: canonical.codeRoots,
              resourceRoots,
              executablePaths,
              readOnlyRoots,
              writeRoots,
              scratchRoot,
              loopbackPorts: permissions.loopbackPorts ?? [],
              unixSocketPaths
            })
          )
      })
      const invocation = buildMacOsSandboxExecInvocation({
        profilePath: artifacts.profilePath,
        scratchRoot: artifacts.scratchRoot,
        bareExecutable: canonical.bareExecutable,
        childEntry: canonical.childEntry,
        generation
      })
      let child: SpawnedSandboxProcess
      try {
        child = options.spawn
          ? options.spawn(invocation.file, invocation.args, invocation.options)
          : await spawnBareProcess(
              invocation.file,
              invocation.args,
              invocation.options
            )
      } catch (error) {
        return cleanupAndRethrow(
          error,
          artifacts.cleanup,
          'tool sandbox spawn failed'
        )
      }

      const protocolStream = child.stdio[3] ?? null
      if (!isProtocolStream(protocolStream)) {
        child.kill()
        return cleanupAndRethrow(
          new Error('sandbox process did not expose protocol fd 3'),
          artifacts.cleanup,
          'tool sandbox protocol startup failed'
        )
      }
      const diagnostics = captureStderr(child.stdio[2] ?? null)
      const exited = observeExit(child)
      let exitedState = false
      void exited.then(
        () => {
          exitedState = true
        },
        () => {
          exitedState = true
        }
      )
      void exited.finally(artifacts.cleanup).catch(() => {})
      let ipc: SandboxIpc
      try {
        ipc = wrap(protocolStream)
      } catch (error) {
        child.kill()
        await Promise.race([exited, delay(500)])
        if (!exitedState) child.kill(9)
        await Promise.race([exited, delay(1_000)])
        return cleanupAndRethrow(
          error,
          artifacts.cleanup,
          'tool sandbox protocol setup failed'
        )
      }
      const client = connectToolSandbox(ipc)
      const startup = Promise.race([
        ipc.ready,
        exited.then((exit) => {
          throw startupError(exit, diagnostics.value)
        })
      ])
      const initialized = startup.then(async () => {
        const configuration =
          typeof permissions.configuration === 'function'
            ? permissions.configuration({
                scratchRoot: artifacts.scratchRoot
              })
            : permissions.configuration
        if (configuration) {
          await client.configure({
            generation,
            configuration
          })
        }
      })
      const description = initialized.then(() => client.ready())
      let closing: Promise<void> | undefined

      return {
        agentId,
        generation,
        exited,
        cleanup: artifacts.cleanup,
        sandbox: {
          async configure(input) {
            await startup
            return client.configure(input)
          },
          async ready() {
            try {
              const ready = await description
              if (ready.generation !== generation) {
                throw new Error('sandbox child reported a mismatched generation')
              }
              return ready
            } catch (error) {
              try {
                await closeProcess()
              } catch (closeError) {
                throw new AggregateError(
                  [
                    ...flattenErrors(error),
                    ...flattenErrors(closeError)
                  ],
                  'tool sandbox readiness cleanup failed'
                )
              }
              throw error
            }
          },
          async invoke(input) {
            await initialized
            return client.invoke(input)
          },
          async cancel(input) {
            await initialized
            await client.cancel(input)
          },
          close: closeProcess
        }
      }

      function closeProcess() {
        closing ??= terminateProcess()
        return closing
      }

      async function terminateProcess() {
        const errors: Error[] = []
        try {
          if (!exitedState) {
            await Promise.race([ipc.terminate(), exited, delay(500)])
            if (!exitedState) child.kill()
            await Promise.race([exited, delay(500)])
            if (!exitedState) child.kill(9)
            await Promise.race([
              exited,
              delay(1_000).then(() => {
                throw new Error('sandbox process did not terminate')
              })
            ])
          } else {
            await exited
          }
          await client.close()
        } catch (error) {
          errors.push(toError(error))
        } finally {
          try {
            await artifacts.cleanup()
          } catch (error) {
            errors.push(toError(error))
          }
        }
        throwCollected(errors, 'tool sandbox close failed')
      }
    }
  }

  async function canonicalConfiguration() {
    const [
      bareExecutable,
      childEntry,
      canonicalExecutablePaths,
      canonicalCodeRoots,
      canonicalReadOnlyRoots,
      canonicalWriteRoots,
      temporaryRoot
    ] = await Promise.all([
      fs.realpath(options.bareExecutable),
      fs.realpath(options.childEntry),
      canonicalPaths(executablePaths),
      canonicalPaths(codeRoots),
      canonicalPaths(readOnlyRoots),
      canonicalPaths(writeRoots),
      fs.realpath(options.temporaryRoot ?? os.tmpdir())
    ])
    return {
      bareExecutable,
      childEntry,
      executablePaths: canonicalExecutablePaths,
      codeRoots: canonicalCodeRoots,
      readOnlyRoots: canonicalReadOnlyRoots,
      writeRoots: canonicalWriteRoots,
      temporaryRoot
    }
  }
}

function canonicalPaths(paths: readonly string[]) {
  return Promise.all(paths.map((value) => fs.realpath(value)))
}

async function optionalCanonicalPaths(paths: readonly string[]) {
  return Promise.all(
    paths.map(async (value) => {
      try {
        return await fs.realpath(value)
      } catch {
        // Obsidian's CLI socket exists only while the app is running.
        if (!path.isAbsolute(value) || value.includes('\0')) {
          throw new Error(`unix socket path must be absolute: ${value}`)
        }
        return value
      }
    })
  )
}

function sortedUnique(values: readonly string[]) {
  return [...new Set(values)].sort((left, right) =>
    left < right ? -1 : left > right ? 1 : 0
  )
}

async function spawnBareProcess(
  file: string,
  args: readonly string[],
  options: SandboxSpawnOptions
) {
  const subprocess = await import('bare-subprocess')
  return subprocess.spawn(file, [...args], {
    cwd: options.cwd,
    env: { ...options.env },
    shell: false,
    stdio: ['ignore', 'ignore', 'pipe', 'pipe']
  })
}

async function loadWrap() {
  const stow = await import('bare-stow/host')
  const wrap = Reflect.get(stow, 'wrap') ?? Reflect.get(stow, 'default')
  if (typeof wrap !== 'function') {
    throw new Error('bare-stow host did not export wrap')
  }
  return function wrapStream(stream: HarnessStream): SandboxIpc {
    return Reflect.apply(wrap, undefined, [stream])
  }
}

function observeExit(
  child: SpawnedSandboxProcess
): Promise<ToolSandboxProcessExit> {
  return new Promise((resolve) => {
    child.once('exit', (code, signal) => resolve({ code, signal }))
  })
}

function captureStderr(stream: HarnessStream | DiagnosticStream | null) {
  const diagnostics = { value: '' }
  if (isDiagnosticStream(stream)) {
    stream.on('data', (data: Uint8Array) => {
      if (diagnostics.value.length >= 65_536) return
      diagnostics.value += String(data).slice(
        0,
        65_536 - diagnostics.value.length
      )
    })
  }
  return diagnostics
}

function isDiagnosticStream(
  stream: HarnessStream | DiagnosticStream | null
): stream is DiagnosticStream {
  return stream !== null && typeof Reflect.get(stream, 'on') === 'function'
}

function startupError(
  exit: ToolSandboxProcessExit,
  diagnostics: string
) {
  const status = exit.signal
    ? `signal ${exit.signal}`
    : `code ${exit.code ?? 'unknown'}`
  const suffix = diagnostics.trim() ? `: ${diagnostics.trim()}` : ''
  return new Error(`tool sandbox exited before ready (${status})${suffix}`)
}

function isProtocolStream(
  stream: HarnessStream | DiagnosticStream | null
): stream is HarnessStream {
  return (
    stream !== null &&
    typeof Reflect.get(stream, 'on') === 'function' &&
    typeof Reflect.get(stream, 'destroy') === 'function'
  )
}

function delay(milliseconds: number) {
  return new Promise<void>((resolve) => {
    setTimeout(resolve, milliseconds)
  })
}

async function cleanupAndRethrow(
  primary: unknown,
  cleanup: () => Promise<void>,
  message: string
): Promise<never> {
  const errors = [toError(primary)]
  try {
    await cleanup()
  } catch (error) {
    errors.push(toError(error))
  }
  if (errors.length === 1) throw errors[0]
  throw new AggregateError(errors, message)
}

function throwCollected(errors: readonly Error[], message: string) {
  if (errors.length === 0) return
  if (errors.length === 1) throw errors[0]
  throw new AggregateError(errors, message)
}

function toError(error: unknown) {
  return error instanceof Error ? error : new Error(String(error))
}

function flattenErrors(error: unknown): Error[] {
  if (error instanceof AggregateError) {
    return error.errors.flatMap(flattenErrors)
  }
  return [toError(error)]
}
