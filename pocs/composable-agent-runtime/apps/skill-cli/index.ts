import AbortController from 'bare-abort-controller'
import Buffer from 'bare-buffer'
import fs from 'bare-fs/promises'
import os from 'bare-os'
import process from 'bare-process'
import { spawn } from 'bare-subprocess'
import {
  createProductionRunnerDependencies,
  createSmokeRunnerDependencies,
  executeDesktopCli,
  runBoundedCommand,
  sanitizePublicText,
  serializePublicRunnerEvent,
  type RunnerPreflightPort
} from './runner.ts'

const PREFLIGHT_COMMAND_TIMEOUT_MS = 5_000
const PREFLIGHT_TERMINATION_GRACE_MS = 250
const PREFLIGHT_OUTPUT_LIMIT = 64 * 1024

const controller = new AbortController()
const interrupt = () => controller.abort('desktop runner interrupted')
process.once('SIGINT', interrupt)
process.once('SIGTERM', interrupt)

try {
  const command = process.argv[2]
  const runner = command === 'smoke'
    ? createSmokeRunnerDependencies()
    : createProductionRunnerDependencies()
  const outcome = await executeDesktopCli(
    {
      argv: process.argv.slice(2),
      environment: process.env,
      signal: controller.signal,
      writeJson(line) {
        console.log(line)
      },
      writeHuman(line) {
        console.error(line)
      }
    },
    {
      preflight: createSystemPreflight(),
      runner
    }
  )
  process.exitCode = outcome.exitCode
} catch (error) {
  const message = error instanceof Error && error.message
    ? sanitizePublicText(error.message.slice(0, 500))
    : 'desktop runner failed'
  console.error(serializePublicRunnerEvent({
    type: 'runner-error',
    elapsedMs: 0,
    message
  }))
  console.error(`failed: ${message}`)
  process.exitCode = 1
} finally {
  process.removeListener('SIGINT', interrupt)
  process.removeListener('SIGTERM', interrupt)
}

function createSystemPreflight(): RunnerPreflightPort {
  return {
    platform: os.platform(),
    bareProbeEntry: new URL('./bare-probe.ts', import.meta.url).pathname,
    async inspect(path) {
      try {
        const entry = await fs.stat(path)
        if (entry.isFile()) return 'file'
        if (entry.isDirectory()) return 'directory'
        return 'missing'
      } catch {
        return 'missing'
      }
    },
    realpath(path) {
      return fs.realpath(path)
    },
    async inspectExecutable(path) {
      try {
        const entry = await fs.stat(path)
        const executable = entry.isFile() && (entry.mode & 0o111) !== 0
        if (!executable) return { executable: false, native: false }
        const handle = await fs.open(path, 'r')
        try {
          const header = Buffer.alloc(4)
          const readResult: unknown = await handle.read(
            header,
            0,
            header.byteLength,
            0
          )
          const bytesRead = readByteCount(readResult)
          return {
            executable: true,
            native:
              bytesRead === header.byteLength &&
              isMachOHeader(header)
          }
        } finally {
          await handle.close()
        }
      } catch {
        return { executable: false, native: false }
      }
    },
    runCommand(file, args) {
      return runBoundedCommand({
        file,
        args,
        timeoutMs: PREFLIGHT_COMMAND_TIMEOUT_MS,
        terminationGraceMs: PREFLIGHT_TERMINATION_GRACE_MS,
        outputLimit: PREFLIGHT_OUTPUT_LIMIT,
        spawn(command, commandArgs) {
          const child = spawn(command, [...commandArgs], {
            shell: false,
            stdio: ['ignore', 'pipe', 'pipe']
          })
          return {
            stdout: child.stdout
              ? {
                  onData(listener) {
                    child.stdout?.on('data', (chunk) => listener(String(chunk)))
                  }
                }
              : null,
            stderr: child.stderr
              ? {
                  onData(listener) {
                    child.stderr?.on('data', (chunk) => listener(String(chunk)))
                  }
                }
              : null,
            onExit(listener) {
              child.once('exit', listener)
            },
            onError(listener) {
              child.once('error', listener)
            },
            kill(signal) {
              child.kill(signal === 'SIGTERM' ? 15 : 9)
            }
          }
        }
      })
    }
  }
}

function isMachOHeader(header: Uint8Array) {
  const magic = Buffer.from(header).readUInt32BE(0)
  return (
    magic === 0xfeedface ||
    magic === 0xcefaedfe ||
    magic === 0xfeedfacf ||
    magic === 0xcffaedfe ||
    magic === 0xcafebabe ||
    magic === 0xbebafeca
  )
}

function readByteCount(result: unknown) {
  if (typeof result === 'number') return result
  if (typeof result !== 'object' || result === null) return 0
  const bytesRead = Reflect.get(result, 'bytesRead')
  return typeof bytesRead === 'number' ? bytesRead : 0
}
