import { spawn } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { parseTaskCommand } from '../index.ts'

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

  it('uses .assistant when durable storage is not configured', () => {
    expect(parseTaskCommand(['observe', '--once'])).toMatchObject({
      mode: 'observe',
      storagePath: '.assistant'
    })
  })
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
