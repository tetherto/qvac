import test from 'brittle'
import fs from 'bare-fs/promises'
import os from 'bare-os'
import path from 'bare-path'
import process from 'bare-process'
import * as tcp from 'bare-tcp'
import * as Harness from '../index.ts'

const START_TIMEOUT_MS = 30_000
const OPERATION_TIMEOUT_MS = 5_000

test('real macOS Seatbelt probe enforces filesystem and network policy', async (t) => {
  if (process.platform !== 'darwin' || !(await isExecutable('/usr/bin/sandbox-exec'))) {
    t.ok(true, 'sandbox-exec probe skipped outside supported macOS hosts')
    return
  }

  const createLauncher = Reflect.get(Harness, 'createMacOsToolSandboxLauncher')
  const createRegistry = Reflect.get(Harness, 'createToolSandboxRegistry')
  t.is(typeof createLauncher, 'function', 'real launcher is available')
  t.is(typeof createRegistry, 'function', 'sandbox registry is available')
  if (typeof createLauncher !== 'function' || typeof createRegistry !== 'function') return

  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'qvac-seatbelt-probe-'))
  await fs.chmod(root, 0o700)
  const resourceRoot = path.join(root, 'selected-resource')
  const resourceFile = path.join(resourceRoot, 'allowed.txt')
  const deniedFile = path.join(root, 'denied.txt')
  await fs.mkdir(resourceRoot, { mode: 0o700 })
  await fs.writeFile(resourceFile, 'resource-ok\n', { mode: 0o600 })
  await fs.writeFile(deniedFile, 'synthetic-denied\n', { mode: 0o600 })

  const server = tcp.createServer()
  server.on('connection', (socket) => socket.end())
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', resolve)
  })
  const loopbackPort = server.address().port
  const host = `${process.platform}-${process.arch}`
  const bareExecutable = path.resolve(
    process.cwd(),
    '../../node_modules/bare-sidecar/prebuilds',
    host,
    'bare'
  )
  const childEntry = path.resolve(
    process.cwd(),
    'test/fixtures/.stow/tool-sandbox-probe/entry.bundle'
  )
  const serviceProbeExecutable = path.resolve(
    process.cwd(),
    'test/fixtures/.stow/tool-sandbox-probe/service-probe'
  )
  const launcher = createLauncher({
    bareExecutable,
    childEntry,
    resourceRootsForAgent: () => [resourceRoot],
    codeRoots: [path.dirname(childEntry)],
    readOnlyRoots: [],
    executablePaths: [serviceProbeExecutable],
    writeRoots: [],
    permissionsForAgent: () => ({ loopbackPorts: [loopbackPort] }),
    temporaryRoot: root
  })
  const registry = createRegistry({ launcher })

  try {
    const description = await bounded(
      registry.ready('probe-agent'),
      START_TIMEOUT_MS
    )
    t.is(description.generation, 1, 'real child completed HRPC readiness')
    const result = await bounded(
      registry.invoke({
        agentId: 'probe-agent',
        invocationId: 'probe-invocation',
        toolName: '__sandbox_probe__',
        input: {
          resourceFile,
          deniedFile,
          loopbackPort,
          serviceProbeExecutable
        }
      }),
      OPERATION_TIMEOUT_MS
    )
    t.alike(
      result,
      {
        status: 'success',
        invocationId: 'probe-invocation',
        generation: 1,
        value: {
          allowedResource: 'resource-ok\n',
          deniedFile: true,
          allowedScratch: 'scratch-ok\n',
          allowedLoopback: true,
          deniedExternalNetwork: true,
          deniedSystemFile: true,
          deniedSystemService: true,
          deniedUnixSocket: true
        }
      },
      'Seatbelt allows explicit private resources, scratch, and loopback while denying synthetic file and external network access'
    )
  } finally {
    await bounded(registry.close(), OPERATION_TIMEOUT_MS)
    await closeServer(server)
  }

  const cleanupProbe = await launcher.launch({
    agentId: 'cleanup-probe-agent',
    generation: 1
  })
  await bounded(cleanupProbe.sandbox.ready(), START_TIMEOUT_MS)
  await fs.chmod(root, 0o500)
  let cleanupCloseError: Error | undefined
  const closeWithBlockedCleanup = cleanupProbe.sandbox.close().catch((error) => {
    cleanupCloseError =
      error instanceof Error ? error : new Error(String(error))
  })
  const cleanupProbeExit = await bounded(
    cleanupProbe.exited,
    OPERATION_TIMEOUT_MS
  )
  await bounded(closeWithBlockedCleanup, OPERATION_TIMEOUT_MS)
  t.ok(
    cleanupProbeExit.code !== null || cleanupProbeExit.signal !== null,
    'process exit remains observable when artifact cleanup fails'
  )
  t.ok(
    cleanupCloseError !== undefined,
    'cleanup failure is surfaced separately from exit'
  )
  await fs.chmod(root, 0o700)
  await cleanupProbe.cleanup()

  const entries = await fs.readdir(root)
  t.ok(
    !entries.some((entry) => entry.startsWith('qvac-tool-sandbox-')),
    'clean close removed private sandbox profile and scratch artifacts'
  )
  await fs.rm(root, { recursive: true, force: true })
})

test('real Seatbelt keeps two agents resources and scratch roots disjoint', async (t) => {
  if (process.platform !== 'darwin' || !(await isExecutable('/usr/bin/sandbox-exec'))) {
    t.ok(true, 'two-agent isolation probe skipped outside supported macOS hosts')
    return
  }

  const createLauncher = Reflect.get(Harness, 'createMacOsToolSandboxLauncher')
  const createRegistry = Reflect.get(Harness, 'createToolSandboxRegistry')
  t.is(typeof createLauncher, 'function', 'real launcher is available')
  t.is(typeof createRegistry, 'function', 'sandbox registry is available')
  if (typeof createLauncher !== 'function' || typeof createRegistry !== 'function') return

  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'qvac-two-agent-probe-'))
  await fs.chmod(root, 0o700)
  const resources = new Map<string, string>()
  for (const agentId of ['isolate-a', 'isolate-b']) {
    const directory = path.join(root, `${agentId}-resource`)
    await fs.mkdir(directory, { mode: 0o700 })
    await fs.writeFile(path.join(directory, 'allowed.txt'), `${agentId}\n`, {
      mode: 0o600
    })
    resources.set(agentId, directory)
  }
  const server = tcp.createServer()
  server.on('connection', (socket) => socket.end())
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', resolve)
  })
  const loopbackPort = server.address().port
  const host = `${process.platform}-${process.arch}`
  const bareExecutable = path.resolve(
    process.cwd(),
    '../../node_modules/bare-sidecar/prebuilds',
    host,
    'bare'
  )
  const childEntry = path.resolve(
    process.cwd(),
    'test/fixtures/.stow/tool-sandbox-probe/entry.bundle'
  )
  const serviceProbeExecutable = path.resolve(
    process.cwd(),
    'test/fixtures/.stow/tool-sandbox-probe/service-probe'
  )
  const launcher = createLauncher({
    bareExecutable,
    childEntry,
    codeRoots: [path.dirname(childEntry)],
    resourceRootsForAgent(agentId: string) {
      const resource = resources.get(agentId)
      if (!resource) throw new Error(`missing resource for ${agentId}`)
      return [resource]
    },
    readOnlyRoots: [],
    executablePaths: [serviceProbeExecutable],
    writeRoots: [],
    permissionsForAgent: () => ({ loopbackPorts: [loopbackPort] }),
    temporaryRoot: root
  })
  const registry = createRegistry({ launcher, idleTimeoutMs: 100 })

  try {
    await Promise.all([
      bounded(registry.ready('isolate-a'), START_TIMEOUT_MS),
      bounded(registry.ready('isolate-b'), START_TIMEOUT_MS)
    ])
    const entries = await fs.readdir(root)
    const scratchA = scratchFor(entries, root, 'isolate-a', 1)
    const scratchB = scratchFor(entries, root, 'isolate-b', 1)
    await fs.writeFile(path.join(scratchA, 'other.txt'), 'scratch-a\n')
    await fs.writeFile(path.join(scratchB, 'other.txt'), 'scratch-b\n')

    const activeA = registry.invoke({
      agentId: 'isolate-a',
      invocationId: 'isolate-a-call',
      toolName: '__sandbox_probe__',
      input: {
        resourceFile: path.join(required(resources, 'isolate-a'), 'allowed.txt'),
        deniedFile: path.join(required(resources, 'isolate-b'), 'allowed.txt'),
        deniedScratchFile: path.join(scratchB, 'other.txt'),
        holdMs: 300,
        loopbackPort,
        serviceProbeExecutable
      }
    })
    const activeB = registry.invoke({
      agentId: 'isolate-b',
      invocationId: 'isolate-b-call',
      toolName: '__sandbox_probe__',
      input: {
        resourceFile: path.join(required(resources, 'isolate-b'), 'allowed.txt'),
        deniedFile: path.join(required(resources, 'isolate-a'), 'allowed.txt'),
        deniedScratchFile: path.join(scratchA, 'other.txt'),
        holdMs: 300,
        loopbackPort,
        serviceProbeExecutable
      }
    })
    await delay(150)
    t.ok(
      (await fs.readdir(root)).some((entry) =>
        entry.startsWith('qvac-tool-sandbox-isolate-a-g1-')
      ),
      'idle expiry never closes active generation one'
    )
    const resultA = await bounded(activeA, OPERATION_TIMEOUT_MS)
    const resultB = await bounded(activeB, OPERATION_TIMEOUT_MS)
    assertAgentIsolation(t, resultA, 'isolate-a\n', 'agent A')
    assertAgentIsolation(t, resultB, 'isolate-b\n', 'agent B')

    await waitFor(async () =>
      !(await fs.readdir(root)).some((entry) =>
        entry.startsWith('qvac-tool-sandbox-isolate-a-g1-')
      )
    )
    const restarted = await bounded(
      registry.ready('isolate-a'),
      START_TIMEOUT_MS
    )
    t.is(restarted.generation, 2, 'idle agent restarts lazily in generation two')
  } finally {
    await bounded(registry.close(), OPERATION_TIMEOUT_MS)
    await closeServer(server)
    await fs.rm(root, { recursive: true, force: true })
  }
})

function scratchFor(
  entries: readonly string[],
  root: string,
  agentId: string,
  generation: number
) {
  const prefix = `qvac-tool-sandbox-${agentId}-g${generation}-`
  const directory = entries.find((entry) => entry.startsWith(prefix))
  if (!directory) throw new Error(`missing sandbox artifacts for ${agentId}`)
  return path.join(root, directory, 'scratch')
}

function required(values: ReadonlyMap<string, string>, key: string) {
  const value = values.get(key)
  if (!value) throw new Error(`missing fixture value for ${key}`)
  return value
}

function assertAgentIsolation(
  t: { alike(actual: unknown, expected: unknown, message?: string): void },
  result: unknown,
  expectedResource: string,
  label: string
) {
  const value = Reflect.get(result ?? {}, 'value') ?? {}
  t.alike(
    {
      status: Reflect.get(result ?? {}, 'status'),
      allowedResource: Reflect.get(value, 'allowedResource'),
      deniedFile: Reflect.get(value, 'deniedFile'),
      deniedScratch: Reflect.get(value, 'deniedScratch')
    },
    {
      status: 'success',
      allowedResource: expectedResource,
      deniedFile: true,
      deniedScratch: true
    },
    `${label} reads only its own resource and scratch roots`
  )
}

async function waitFor(predicate: () => Promise<boolean>) {
  const deadline = Date.now() + OPERATION_TIMEOUT_MS
  while (!(await predicate())) {
    if (Date.now() >= deadline) {
      throw new Error('timed out waiting for sandbox state')
    }
    await delay(10)
  }
}

function delay(milliseconds: number) {
  return new Promise<void>((resolve) => {
    setTimeout(resolve, milliseconds)
  })
}

async function isExecutable(file: string) {
  try {
    await fs.access(file)
    return true
  } catch {
    return false
  }
}

async function bounded<T>(promise: Promise<T>, milliseconds: number) {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<T>((_resolve, reject) => {
    timer = setTimeout(
      () => reject(new Error(`sandbox probe exceeded ${milliseconds}ms`)),
      milliseconds
    )
  })
  try {
    return await Promise.race([promise, timeout])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

function closeServer(server: tcp.TCPServer) {
  return new Promise<void>((resolve) => {
    server.close(() => resolve())
  })
}
