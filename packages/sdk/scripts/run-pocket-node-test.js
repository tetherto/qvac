// Supervise the test separately: native worker shutdown can block indefinitely.
import { spawn, spawnSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export function runSupervised(script, { deadlineMs = 75000 } = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [script], {
      stdio: 'inherit',
      detached: process.platform !== 'win32'
    })
    let failed = false
    const stopTree = () => {
      if (!child.pid) return
      if (process.platform === 'win32') {
        spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], {
          stdio: 'ignore',
          timeout: 5000
        })
      } else {
        try {
          process.kill(-child.pid, 'SIGKILL')
        } catch (error) {
          if (error.code !== 'ESRCH') throw error
        }
      }
    }
    const abort = () => {
      failed = true
      stopTree()
    }
    const deadline = setTimeout(() => {
      console.error('Pocket IPC test exceeded its shutdown deadline')
      abort()
    }, deadlineMs)
    process.once('SIGINT', abort)
    process.once('SIGTERM', abort)
    const finish = (code) => {
      clearTimeout(deadline)
      process.removeListener('SIGINT', abort)
      process.removeListener('SIGTERM', abort)
      // Also reap workers left behind by an unexpected test-process exit.
      stopTree()
      resolve(failed ? 1 : (code ?? 1))
    }
    child.once('error', (error) => {
      console.error('Could not start Pocket IPC test', error)
      finish(1)
    })
    child.once('exit', finish)
  })
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await runSupervised(
    fileURLToPath(new URL('./pocket-node-test.js', import.meta.url))
  )
}
