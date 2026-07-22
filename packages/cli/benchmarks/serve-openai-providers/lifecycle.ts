import { spawn } from 'node:child_process'
import type { ProviderConfig } from './types.ts'

export type CommandExecutor = (command: string[]) => Promise<void>

export function executeCommand(command: string[]): Promise<void> {
  if (command.length === 0) {
    return Promise.reject(new Error('lifecycle command must be a non-empty argv array'))
  }
  const file = command[0]!
  const args = command.slice(1)
  return new Promise<void>((resolve, reject) => {
    const child = spawn(file, args, { shell: false, stdio: 'inherit' })
    child.on('error', reject)
    child.on('close', (code, signal) => {
      if (signal !== null) {
        reject(new Error(`command ${file} terminated by signal ${signal}`))
        return
      }
      if (code !== 0) {
        reject(new Error(`command ${file} exited with code ${code}`))
        return
      }
      resolve()
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
  if (startCommand) {
    await execute(startCommand)
  }
  let operationError: unknown
  let operationFailed = false
  try {
    return await operation()
  } catch (error) {
    operationFailed = true
    operationError = error
    throw error
  } finally {
    if (stopCommand) {
      try {
        await execute(stopCommand)
      } catch (stopError) {
        if (operationFailed) {
          throw new AggregateError(
            [operationError, stopError],
            'provider operation failed and stop command failed'
          )
        }
        throw stopError
      }
    }
  }
}
