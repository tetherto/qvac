import { spawn } from 'node:child_process'
import type { ProviderConfig } from './types'

export const DEFAULT_COMMAND_TIMEOUT_MS = 30_000
export const DEFAULT_KILL_GRACE_MS = 5_000

export type CommandExecutor = (command: string[], timeoutMs?: number) => Promise<void>

export function executeCommand(
  command: string[],
  timeoutMs: number = DEFAULT_COMMAND_TIMEOUT_MS,
  killGraceMs: number = DEFAULT_KILL_GRACE_MS
): Promise<void> {
  if (command.length === 0) {
    return Promise.reject(new Error('lifecycle command must be a non-empty argv array'))
  }
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    return Promise.reject(new Error('lifecycle command timeout must be positive'))
  }
  if (!Number.isFinite(killGraceMs) || killGraceMs <= 0) {
    return Promise.reject(new Error('lifecycle command kill grace must be positive'))
  }
  const file = command[0]!
  const args = command.slice(1)
  return new Promise<void>((resolve, reject) => {
    const child = spawn(file, args, { shell: false, stdio: 'inherit' })
    let settled = false
    let timedOut = false
    let killGrace: ReturnType<typeof setTimeout> | undefined
    const timeoutError = new Error(`command ${file} timed out after ${timeoutMs}ms`)
    const timeout = setTimeout(() => {
      if (settled) {
        return
      }
      timedOut = true
      child.kill('SIGKILL')
      killGrace = setTimeout(() => settle(timeoutError), killGraceMs)
    }, timeoutMs)
    function settle(error?: Error): void {
      if (settled) {
        return
      }
      settled = true
      clearTimeout(timeout)
      if (killGrace !== undefined) {
        clearTimeout(killGrace)
      }
      if (error) {
        reject(error)
      } else {
        resolve()
      }
    }
    child.on('error', (error) => {
      if (!timedOut) {
        settle(error)
      }
    })
    child.on('close', (code, signal) => {
      if (timedOut) {
        settle(timeoutError)
        return
      }
      if (signal !== null) {
        settle(new Error(`command ${file} terminated by signal ${signal}`))
        return
      }
      if (code !== 0) {
        settle(new Error(`command ${file} exited with code ${code}`))
        return
      }
      settle()
    })
  })
}

export async function runProviderLifecycle<T>(
  provider: ProviderConfig,
  operation: () => Promise<T>,
  execute: CommandExecutor = executeCommand
): Promise<T> {
  const startCommand = provider.lifecycle?.start_command
  const stopCommand = provider.lifecycle?.stop_command
  const timeoutMs =
    (provider.lifecycle?.timeout_seconds ?? DEFAULT_COMMAND_TIMEOUT_MS / 1000) * 1000
  let result: T | undefined
  let primaryError: unknown
  let primaryFailed = false
  let startAttempted = false
  try {
    if (startCommand) {
      startAttempted = true
      await execute(startCommand, timeoutMs)
    }
    result = await operation()
  } catch (error) {
    primaryFailed = true
    primaryError = error
  }

  let stopError: unknown
  let stopFailed = false
  if (stopCommand && (!startCommand || startAttempted)) {
    try {
      await execute(stopCommand, timeoutMs)
    } catch (error) {
      stopFailed = true
      stopError = error
    }
  }

  if (primaryFailed && stopFailed) {
    throw new AggregateError(
      [primaryError, stopError],
      'provider operation failed and stop command failed'
    )
  }
  if (primaryFailed) {
    throw primaryError
  }
  if (stopFailed) {
    throw stopError
  }
  return result as T
}
