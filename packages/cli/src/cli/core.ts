import type { RuntimeOptions } from '../lib/types.js'
import { bootCore } from '../lib/runtime/core-host.js'
import { CommandError } from './errors.js'
import type { CommandIO } from './io.js'

// fd-lock's message when the store's single writer is already another process.
const LOCKED = 'File descriptor could not be locked'

export { CommandError }

export async function startCore(options: RuntimeOptions, io: CommandIO) {
  if (io.tty.stderr) {
    io.stderr.write('Starting QV.AC…\n')
  }

  try {
    // commands join through Core's routes themselves, after asking or previewing
    return await bootCore({ ...options, join: null, deviceJoin: null })
  } catch (caught) {
    const error: Error & { locked?: boolean } =
      caught instanceof Error ? caught : new Error(String(caught))
    if (!error.locked && !error.message.includes(LOCKED)) {
      throw error
    }

    throw new CommandError(
      `another qvac is already running on ${options.dataDir}, and a device's state has one writer. Stop it first, or pass --data-dir for a separate device.`,
      { locked: true }
    )
  }
}
