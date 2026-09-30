import { spawn, type ChildProcess } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { BaseExecutor, type TestResult } from '@qvac/test-suite'
import {
  noLingeringBareTests,
  noLingeringBareSigterm,
  noLingeringBareClose,
  noLingeringBareIpcDisconnect
} from '../../../no-lingering-bare-tests.js'
import { isAlive, waitForBareChildren } from '../../../utils/bare-worker.js'

type ShutdownMode = 'sigterm' | 'close' | 'ipc-disconnect'

const CONSUMER_BOOT_TIMEOUT_MS = 60_000
const CONSUMER_EXIT_TIMEOUT_MS = 20_000
const BARE_EXIT_GRACE_MS = 15_000
const BARE_DISCOVERY_TIMEOUT_MS = 5_000
const POLL_INTERVAL_MS = 200

const consumerScriptPath = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  '..',
  'utils',
  'no-lingering-bare-consumer.js'
)

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function pollUntilDead(pid: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (!isAlive(pid)) return true
    await sleep(POLL_INTERVAL_MS)
  }
  return !isAlive(pid)
}

function assertCleanExit(
  mode: ShutdownMode,
  exit: { code: number | null; signal: string | null }
): string | null {
  if (mode === 'close' && (exit.code !== 0 || exit.signal !== null)) {
    return `close() exit was not clean: code=${exit.code}, signal=${exit.signal}`
  }
  if (mode === 'sigterm' && exit.code !== null && exit.code !== 0) {
    return `sigterm exit code was non-zero: code=${exit.code}, signal=${exit.signal}`
  }
  return null
}

export class NoLingeringBareExecutor extends BaseExecutor<typeof noLingeringBareTests> {
  pattern = /^no-lingering-bare-/

  protected handlers = {
    [noLingeringBareSigterm.testId]: () => this.runTest('sigterm'),
    [noLingeringBareClose.testId]: () => this.runTest('close'),
    [noLingeringBareIpcDisconnect.testId]: () => this.runTest('ipc-disconnect')
  }

  private spawnConsumer(mode: ShutdownMode): ChildProcess {
    return spawn(process.execPath, [consumerScriptPath, mode], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, NODE_ENV: process.env.NODE_ENV ?? 'test' }
    })
  }

  private waitForReady(child: ChildProcess, stderr: string[]): Promise<void> {
    return new Promise((resolve, reject) => {
      let buffer = ''
      let settled = false

      const fail = (err: Error): void => {
        if (settled) return
        settled = true
        clearTimeout(timeout)
        reject(err)
      }

      const timeout = setTimeout(() => {
        fail(
          new Error(
            `Consumer did not print READY within ${CONSUMER_BOOT_TIMEOUT_MS}ms. ` +
              `stderr: ${stderr.join('')}`
          )
        )
      }, CONSUMER_BOOT_TIMEOUT_MS)

      child.once('error', (err: Error) => {
        fail(new Error(`Failed to spawn consumer: ${err.message}. stderr: ${stderr.join('')}`))
      })

      const onData = (chunk: Buffer) => {
        if (settled) return
        buffer += chunk.toString()
        if (buffer.includes('READY')) {
          settled = true
          clearTimeout(timeout)
          child.stdout!.off('data', onData)
          resolve()
        }
      }
      child.stdout!.on('data', onData)

      child.once('exit', (code, signal) => {
        fail(
          new Error(
            `Consumer exited before READY (code=${code}, signal=${signal}). ` +
              `stderr: ${stderr.join('')}`
          )
        )
      })
    })
  }

  private waitForExit(
    child: ChildProcess,
    timeoutMs: number
  ): Promise<{ code: number | null; signal: string | null }> {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error(`Consumer did not exit within ${timeoutMs}ms`))
      }, timeoutMs)

      child.once('exit', (code, signal) => {
        clearTimeout(timeout)
        resolve({ code, signal })
      })
    })
  }

  private async runTest(mode: ShutdownMode): Promise<TestResult> {
    const start = Date.now()
    let consumer: ChildProcess | null = null
    let bareChildren: number[] = []
    const cleanedUp = new Set<number>()
    const stderr: string[] = []

    try {
      consumer = this.spawnConsumer(mode)

      consumer.stderr!.on('data', (chunk: Buffer) => {
        stderr.push(chunk.toString())
      })

      await this.waitForReady(consumer, stderr)

      bareChildren = await waitForBareChildren(
        consumer.pid!,
        (pids) => pids.length > 0,
        BARE_DISCOVERY_TIMEOUT_MS
      )
      if (bareChildren.length === 0) {
        return {
          passed: false,
          output:
            `No bare child process found after ${BARE_DISCOVERY_TIMEOUT_MS}ms — ` +
            `SDK did not spawn a worker. stderr: ${stderr.join('')}`
        }
      }

      const exitPromise = this.waitForExit(consumer, CONSUMER_EXIT_TIMEOUT_MS)

      switch (mode) {
        case 'sigterm':
          consumer.kill('SIGTERM')
          break
        case 'close':
          consumer.stdin!.write('CLOSE\n')
          break
        case 'ipc-disconnect':
          consumer.kill('SIGKILL')
          break
      }

      let exit: { code: number | null; signal: string | null }
      try {
        exit = await exitPromise
      } catch {
        try {
          consumer.kill('SIGKILL')
        } catch {}
        return {
          passed: false,
          output:
            `Consumer did not exit within ${CONSUMER_EXIT_TIMEOUT_MS}ms after ${mode}. ` +
            `stderr: ${stderr.join('')}`
        }
      }
      consumer = null

      const exitError = assertCleanExit(mode, exit)
      if (exitError) {
        return {
          passed: false,
          output: `${exitError}. stderr: ${stderr.join('')}`
        }
      }

      const lingering: number[] = []
      await Promise.all(
        bareChildren.map(async (pid) => {
          const gone = await pollUntilDead(pid, BARE_EXIT_GRACE_MS)
          if (!gone) lingering.push(pid)
        })
      )

      const elapsed = Date.now() - start

      if (lingering.length > 0) {
        for (const pid of lingering) {
          try {
            process.kill(pid, 'SIGKILL')
          } catch {}
          cleanedUp.add(pid)
        }
        return {
          passed: false,
          output:
            `Bare process(es) still alive ${BARE_EXIT_GRACE_MS}ms after ` +
            `consumer exit (mode=${mode}): PIDs ${lingering.join(', ')}. ` +
            `This is the "lingering bare process" regression. ` +
            `stderr: ${stderr.join('')}`
        }
      }

      return {
        passed: true,
        output:
          `Bare worker(s) exited cleanly after SDK shutdown ` +
          `(mode=${mode}, PIDs=${bareChildren.join(', ')}, ${elapsed}ms)`
      }
    } catch (error) {
      return {
        passed: false,
        output:
          `Test error (mode=${mode}): ${error instanceof Error ? error.message : String(error)}. ` +
          `stderr: ${stderr.join('')}`
      }
    } finally {
      if (consumer) {
        try {
          consumer.kill('SIGKILL')
        } catch {}
      }
      for (const pid of bareChildren) {
        if (cleanedUp.has(pid)) continue
        try {
          if (isAlive(pid)) process.kill(pid, 'SIGKILL')
        } catch {}
      }
    }
  }
}
