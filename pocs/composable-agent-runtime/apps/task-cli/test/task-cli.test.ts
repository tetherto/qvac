import { spawn } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type {
  Task,
  TaskRunEvent,
  TaskRunner,
  TaskStore,
  UserProfile
} from '@qvac-poc/task-shared'
import {
  formatPairingUri,
  parseTaskCommand,
  runTaskService
} from '../index.ts'

const temporaryPaths: string[] = []
const appPath = new URL('..', import.meta.url).pathname

afterEach(async () => {
  await Promise.all(
    temporaryPaths.splice(0).map((path) => rm(path, { force: true, recursive: true }))
  )
})

describe('task CLI desktop host', () => {
  it('seeds and passively observes app-owned state across processes', async () => {
    const storagePath = await temporaryStorage()

    const seed = await runCli([
      'seed',
      '--storage',
      storagePath,
      '--name',
      'Ada',
      '--age',
      '37'
    ])
    expect(seed.exitCode).toBe(0)

    const observer = await runCli([
      'observe',
      '--storage',
      storagePath,
      '--once'
    ])
    expect(observer.exitCode).toBe(0)
    expect(JSON.parse(observer.stdout)).toMatchObject({
      mode: 'observer',
      user: { name: 'Ada', age: 37 },
      tasks: [
        { id: 'task-2', order: 1, status: 'pending' },
        { id: 'task-1', order: 2, status: 'pending' }
      ]
    })
  }, 60_000)

  it('executes seeded tasks deterministically and emits traces', async () => {
    const storagePath = await temporaryStorage()
    expect(
      (await runCli(['seed', '--storage', storagePath])).exitCode
    ).toBe(0)

    const execution = await runCli([
      'execute',
      '--storage',
      storagePath,
      '--trace'
    ])
    expect(execution.exitCode).toBe(0)
    expect(JSON.parse(execution.stdout)).toEqual({
      mode: 'executor',
      outcomes: [
        { taskId: 'task-2', status: 'completed' },
        { taskId: 'task-1', status: 'completed' }
      ]
    })
    expect(execution.stderr).toContain('"type":"task-cli.execute.started"')
    expect(execution.stderr).toContain('"type":"task-cli.execute.completed"')
    expect(execution.stderr).toContain('"type":"task-cli.boundary.request"')
    expect(execution.stderr).toContain('"type":"task-cli.boundary.response"')
    expect(execution.stderr).toMatch(/"traceId":"trc_[a-z0-9_]+"/)
    const traces = execution.stderr
      .split('\n')
      .filter((line) => line.startsWith('{'))
      .map((line) => JSON.parse(line))
    const ready = traces
      .filter((trace) => trace.type === 'assistant.runtime.ready')
      .map((trace) => trace.details)
    expect(ready).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          component: 'sync',
          runtime: 'bare',
          processId: expect.any(Number),
          instanceId: expect.stringMatching(/^sync-/)
        }),
        expect.objectContaining({
          component: 'harness',
          runtime: 'bare',
          processId: expect.any(Number),
          instanceId: expect.stringMatching(/^harness-/)
        }),
        expect.objectContaining({
          component: 'sdk',
          runtime: 'bare',
          processId: expect.any(Number),
          instanceId: expect.stringMatching(/^sdk-/)
        })
      ])
    )
    const processIds = ready.map((identity) => identity.processId)
    expect(new Set(processIds).size).toBe(3)
    expect(processIds).not.toContain(process.pid)
    expect(traces).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'task-cli.boundary.request',
          details: expect.objectContaining({
            runtime: 'bare',
            traceId: expect.stringMatching(/^trc_/)
          })
        }),
        expect.objectContaining({
          type: 'task-cli.boundary.response',
          details: expect.objectContaining({
            runtime: 'bare',
            traceId: expect.stringMatching(/^trc_/)
          })
        })
      ])
    )

    const observer = await runCli([
      'observe',
      '--storage',
      storagePath,
      '--once'
    ])
    const snapshot = JSON.parse(observer.stdout)
    expect(snapshot.tasks).toMatchObject([
      { status: 'completed', result: 'deterministic: Reply with exactly FIRST.' },
      { status: 'completed', result: 'deterministic: Reply with exactly SECOND.' }
    ])
  }, 60_000)

  it('exposes Qwen only through an explicit smoke option', () => {
    expect(parseTaskCommand(['execute', '--storage', '/tmp/state'])).toMatchObject({
      mode: 'execute',
      inference: { kind: 'deterministic' },
      model: 'deterministic'
    })
    expect(
      parseTaskCommand(['execute', '--storage', '/tmp/state', '--qwen'])
    ).toMatchObject({
      mode: 'execute',
      inference: { kind: 'qwen' },
      model: join(
        homedir(),
        '.qvac',
        'models',
        '3a65a2a3c6a30a47_Qwen3.5-4B-Q4_K_M.gguf'
      )
    })
  })

  it('accepts only explicit Qwen service mode and formats a pasteable invite', () => {
    expect(() => parseTaskCommand(['serve'])).toThrow(
      'serve requires --qwen'
    )
    expect(
      parseTaskCommand(['serve', '--qwen', '--storage', '/tmp/state'])
    ).toMatchObject({
      mode: 'serve',
      storagePath: '/tmp/state',
      inference: { kind: 'qwen' }
    })

    const invite = Buffer.from([0xfb, 0xff, 0x00, 0x01])
    const uri = formatPairingUri({ invite, expiresAt: 123_000 })
    expect(uri).toBe(
      'qvac-poc://pair?invite=-_8AAQ&expiresAt=123000'
    )
    expect(uri).not.toContain(invite.toString('hex'))
  })

  it('serves pending tasks with partial snapshots before completion', async () => {
    const user: UserProfile = {
      id: 'user-1',
      name: 'Ada',
      age: 37,
      deviceIds: ['device-a']
    }
    const task: Task = {
      id: 'mobile-1',
      text: 'stream a response',
      order: 1,
      status: 'pending'
    }
    const saved: Task[] = []
    const controller = new AbortController()
    const store: TaskStore = {
      async loadCurrentUser() {
        return user
      },
      async listTasks() {
        const current = saved.at(-1)
        return [current ?? task]
      },
      async saveTask(_userId, next) {
        saved.push(next)
        if (next.status === 'completed') controller.abort('test complete')
      },
      async *watchTasks() {
        await new Promise<void>((resolve) => {
          controller.signal.addEventListener('abort', () => resolve(), { once: true })
        })
      }
    }
    const runner: TaskRunner = {
      async *run(): AsyncGenerator<TaskRunEvent> {
        yield { type: 'content', text: 'partial' }
        await new Promise((resolve) => setTimeout(resolve, 5))
        yield { type: 'content', text: ' result' }
      }
    }

    await runTaskService(store, runner, {
      signal: controller.signal,
      partialSnapshotIntervalMs: 1
    })

    expect(saved.map(({ status, result }) => ({ status, result }))).toEqual([
      { status: 'running', result: undefined },
      { status: 'running', result: 'partial' },
      { status: 'running', result: 'partial result' },
      { status: 'completed', result: 'partial result' }
    ])
  })

  it('reports stale running tasks without reclaiming them', async () => {
    const controller = new AbortController()
    const stale: Task = {
      id: 'stale-1',
      text: 'do not replay',
      order: 1,
      status: 'running',
      result: 'unfinished'
    }
    const saved: Task[] = []
    const reported: Array<readonly Task[]> = []
    const store: TaskStore = {
      async loadCurrentUser() {
        return {
          id: 'user-1',
          name: 'Ada',
          age: 37,
          deviceIds: ['device-a']
        }
      },
      async listTasks() {
        return [stale]
      },
      async saveTask(_userId, task) {
        saved.push(task)
      },
      async *watchTasks() {
        controller.abort('test complete')
      }
    }

    await runTaskService(
      store,
      {
        async *run(): AsyncGenerator<TaskRunEvent> {
          throw new Error('stale task was reclaimed')
        }
      },
      {
        signal: controller.signal,
        onStaleTasks(tasks) {
          reported.push(tasks)
        }
      }
    )

    expect(reported).toEqual([[stale]])
    expect(saved).toEqual([])
  })

  it('persists a deterministic failed state when shutdown aborts an active task', async () => {
    const controller = new AbortController()
    const task: Task = {
      id: 'active-1',
      text: 'long run',
      order: 1,
      status: 'pending'
    }
    const saved: Task[] = []
    const store: TaskStore = {
      async loadCurrentUser() {
        return {
          id: 'user-1',
          name: 'Ada',
          age: 37,
          deviceIds: ['device-a']
        }
      },
      async listTasks() {
        return [saved.at(-1) ?? task]
      },
      async saveTask(_userId, next) {
        saved.push(next)
        if (next.status === 'running' && next.result === 'partial') {
          controller.abort('Task service stopped by SIGTERM')
        }
      },
      async *watchTasks() {}
    }
    const runner: TaskRunner = {
      async *run(): AsyncGenerator<TaskRunEvent> {
        yield { type: 'content', text: 'partial' }
      }
    }

    await runTaskService(store, runner, { signal: controller.signal })

    expect(saved.at(-1)).toMatchObject({
      id: 'active-1',
      status: 'failed',
      result: 'partial',
      error: 'Task service stopped by SIGTERM'
    })
  })

  it('uses .assistant when durable storage is not configured', () => {
    expect(parseTaskCommand(['observe', '--once'])).toMatchObject({
      mode: 'observe',
      storagePath: '.assistant'
    })
  })

  it.skipIf(process.env.QVAC_QWEN_SERVICE_SMOKE !== '1')(
    'runs the pre-provisioned Qwen service without downloading a model',
    async () => {
      const storagePath = await temporaryStorage()
      expect(
        (await runCli(['seed', '--storage', storagePath])).exitCode
      ).toBe(0)
      const service = spawn(
        process.execPath,
        [
          '--experimental-strip-types',
          'index.ts',
          'serve',
          '--qwen',
          '--trace',
          '--storage',
          storagePath
        ],
        {
          cwd: appPath,
          stdio: ['ignore', 'pipe', 'pipe']
        }
      )
      let stdout = ''
      let stderr = ''
      service.stdout.on('data', (chunk: Buffer) => {
        stdout += chunk.toString()
      })
      service.stderr.on('data', (chunk: Buffer) => {
        stderr += chunk.toString()
      })
      const closed = new Promise<number>((resolve, reject) => {
        service.once('error', reject)
        service.once('close', (code) => resolve(code ?? 1))
      })
      try {
        await waitForText(
          () =>
            stdout.includes('qvac-poc://pair?') &&
            stderr.split('"type":"task-cli.boundary.response"').length === 3,
          10 * 60_000
        )
        service.kill('SIGTERM')
        expect(await closed).toBe(0)
      } finally {
        if (service.exitCode === null) {
          service.kill('SIGTERM')
          await closed
        }
      }

      const observer = await runCli([
        'observe',
        '--storage',
        storagePath,
        '--once'
      ])
      expect(
        JSON.parse(observer.stdout).tasks.map((task: Task) => task.status)
      ).toEqual(['completed', 'completed'])
    },
    11 * 60_000
  )
})

async function temporaryStorage() {
  const storagePath = await mkdtemp(join(tmpdir(), 'qvac-task-cli-'))
  temporaryPaths.push(storagePath)
  return storagePath
}

async function runCli(args: readonly string[]) {
  const child = spawn(
    process.execPath,
    ['--experimental-strip-types', 'index.ts', ...args],
    {
    cwd: appPath,
    stdio: ['ignore', 'pipe', 'pipe']
    }
  )
  const stdout: Buffer[] = []
  const stderr: Buffer[] = []
  child.stdout.on('data', (chunk: Buffer) => stdout.push(chunk))
  child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk))
  const exitCode = await new Promise<number>((resolve, reject) => {
    child.once('error', reject)
    child.once('close', (code) => resolve(code ?? 1))
  })
  return {
    exitCode,
    stdout: Buffer.concat(stdout).toString().trim(),
    stderr: Buffer.concat(stderr).toString().trim()
  }
}

async function waitForText(predicate: () => boolean, timeoutMs: number) {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    if (Date.now() >= deadline) {
      throw new Error('Timed out waiting for task CLI output')
    }
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
}
