// Streams a command's output while keeping a copy in a log file.

import { writeFileSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { constants } from 'node:os'

export function tee(cmd, args, { cwd, env = process.env, logFile }) {
  return new Promise((ok) => {
    const child = spawn(cmd, args, { cwd, env, shell: process.platform === 'win32' })
    let log = ''
    for (const [from, to] of [
      [child.stdout, process.stdout],
      [child.stderr, process.stderr]
    ]) {
      from.on('data', (d) => {
        log += d
        to.write(d)
      })
    }
    child.on('close', (code, signal) => {
      if (logFile) writeFileSync(logFile, log)
      // A signal reads as 128 + its number, as a shell reports it.
      ok({ code: code ?? 128 + (constants.signals[signal] ?? 0), log })
    })
  })
}
