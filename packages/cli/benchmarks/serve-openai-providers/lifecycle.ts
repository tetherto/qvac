import { spawn } from 'node:child_process'
import type { ProviderConfig } from './types.ts'

export const DEFAULT_COMMAND_TIMEOUT_MS = 30_000

export type CommandExecutor = (command: string[], timeoutMs?: number) => Promise<void>

export function executeCommand(
  command: string[],
  timeoutMs: number = DEFAULT_COMMAND_TIMEOUT_MS
): Promise<void> {
  if (command.length === 0) {
    return Promise.reject(new Error('lifecycle command must be a non-empty argv array'))
  }
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    return Promise.reject(new Error('lifecycle command timeout must be positive'))
  }
  const file = command[0]!
  const args = command.slice(1)
  return new Promise<void>((resolve, reject) => {
    const child = spawn(file, args, { shell: false, stdio: 'inherit' })
    let settled = false
    const timeout = setTimeout(() => {
      if (settled) {
        return
      }
      settled = true
      child.kill('SIGKILL')
      reject(new Error(`command ${file} timed out after ${timeoutMs}ms`))
    }, timeoutMs)
    function settle(error?: Error): void {
      if (settled) {
        return
      }
      settled = true
      clearTimeout(timeout)
      if (error) {
        reject(error)
      } else {
        resolve()
      }
    }
    child.on('error', (error) => settle(error))
    child.on('close', (code, signal) => {
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
  let startAttempted = false
  try {
    if (startCommand) {
      startAttempted = true
      await execute(startCommand, timeoutMs)
    }
    result = await operation()
  } catch (error) {
    primaryError = error
  }

  let stopError: unknown
  if (stopCommand && (!startCommand || startAttempted)) {
    try {
      await execute(stopCommand, timeoutMs)
    } catch (error) {
      stopError = error
    }
  }

  if (primaryError !== undefined && stopError !== undefined) {
    throw new AggregateError(
      [primaryError, stopError],
      'provider operation failed and stop command failed'
    )
  }
  if (primaryError !== undefined) {
    throw primaryError
  }
  if (stopError !== undefined) {
    throw stopError
  }
  return result as T
}
