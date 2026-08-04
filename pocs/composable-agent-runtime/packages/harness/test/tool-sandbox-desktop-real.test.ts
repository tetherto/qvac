import test from 'brittle'
import AbortController from 'bare-abort-controller'
import fs from 'bare-fs/promises'
import os from 'bare-os'
import path from 'bare-path'
import process from 'bare-process'
import * as tcp from 'bare-tcp'
import * as Harness from '../index.ts'

const START_TIMEOUT_MS = 30_000
const OPERATION_TIMEOUT_MS = 5_000

test('real Seatbelt child runs Weather and direct-argv Obsidian within exact capabilities', async (t) => {
  if (
    process.platform !== 'darwin' ||
    !(await isExecutable('/usr/bin/sandbox-exec'))
  ) {
    t.ok(true, 'desktop executor probe skipped outside supported macOS hosts')
    return
  }

  const createTooling = Reflect.get(
    Harness,
    'createMacOsDesktopSkillTooling'
  )
  t.is(typeof createTooling, 'function', 'desktop tooling factory is available')
  if (typeof createTooling !== 'function') return

  const root = await fs.mkdtemp(
    path.join(os.tmpdir(), 'qvac-desktop-executor-probe-')
  )
  await fs.chmod(root, 0o700)
  const vault = path.join(root, 'vault')
  const outside = path.join(root, 'outside.txt')
  await fs.mkdir(vault, { mode: 0o700 })
  await fs.writeFile(path.join(vault, 'allowed.md'), 'vault-ok\n', {
    mode: 0o600
  })
  await fs.writeFile(outside, 'outside-secret\n', { mode: 0o600 })
  await fs.symlink(outside, path.join(vault, 'escape.md'))
  const alternateLoopback = tcp.createServer()
  alternateLoopback.on('connection', (socket) => socket.end())
  await new Promise<void>((resolve) => {
    alternateLoopback.listen(0, '127.0.0.1', resolve)
  })
  const alternateLoopbackPort = alternateLoopback.address().port

  const host = `${process.platform}-${process.arch}`
  const bareExecutable = path.resolve(
    process.cwd(),
    '../../node_modules/bare-sidecar/prebuilds',
    host,
    'bare'
  )
  const artifacts = path.resolve(
    process.cwd(),
    'test/fixtures/.stow/desktop-tool-sandbox'
  )
  const childEntry = path.join(artifacts, 'entry.bundle')
  const obsidianExecutable = path.join(artifacts, 'obsidian')
  let approvalCalls = 0
  const tooling = await createTooling({
    bareExecutable,
    childEntry,
    selectedSkillsForAgent: () => ['weather', 'obsidian'],
    approval: {
      async approve() {
        approvalCalls++
        return approvalCalls > 1
      }
    },
    temporaryRoot: root,
    weather: {
      async fetch(url: URL) {
        return {
          status: 200,
          headers: {},
          body: `synthetic weather for ${url.pathname}`
        }
      }
    },
    obsidian: {
      executablePath: obsidianExecutable,
      vaultRoot: vault,
      vaultIdentity: 'SyntheticVault',
      timeoutMs: 2_000,
      maxOutputBytes: 64
    }
  })

  try {
    t.alike(
      tooling.tools.map((tool: { schema: { name: string } }) => tool.schema.name),
      ['http_request', 'exec'],
      'factory exposes only low-level desktop tool schemas'
    )
    const denied = await invoke(tooling.broker, {
      operationId: 'approval-denied',
      name: 'exec',
      arguments: { command: 'obsidian files' },
      grants: [{ name: 'exec', scope: 'obsidian' }]
    }).catch((error: Error) => error)
    t.ok(
      denied instanceof Error && /approval denied/i.test(denied.message),
      'first Obsidian invocation is denied before sandbox launch'
    )

    const weather = await bounded(
      invoke(tooling.broker, {
        operationId: 'weather',
        name: 'http_request',
        arguments: {
          url: 'https://wttr.in/Probe?format=3',
          method: 'GET'
        },
        grants: [{ name: 'http_request', scope: null }]
      }),
      START_TIMEOUT_MS
    )
    t.alike(
      weather,
      {
        status: 200,
        body: 'synthetic weather for /Probe'
      },
      'real Seatbelt child reaches only the authenticated loopback Weather proxy'
    )

    const deniedLoopback = await bounded(
      invoke(tooling.broker, {
        operationId: 'alternate-loopback',
        name: 'exec',
        arguments: {
          command: `obsidian search query=loopback:${alternateLoopbackPort}`
        },
        grants: [{ name: 'exec', scope: 'obsidian' }]
      }),
      OPERATION_TIMEOUT_MS
    )
    t.alike(
      deniedLoopback,
      {
        exitCode: 0,
        stdout: 'alternate-loopback-denied\n',
        stderr: ''
      },
      'Seatbelt denies every loopback endpoint except the Weather proxy port'
    )

    const scopedFiles = await bounded(
      invoke(tooling.broker, {
        operationId: 'scoped-files',
        name: 'exec',
        arguments: { command: 'obsidian files' },
        grants: [{ name: 'exec', scope: 'obsidian' }]
      }),
      OPERATION_TIMEOUT_MS
    )
    t.alike(
      scopedFiles,
      {
        exitCode: 0,
        stdout: 'SyntheticVault direct-egress-denied\n',
        stderr: ''
      },
      'fake CLI confirms direct external egress remains denied'
    )

    const read = await bounded(
      invoke(tooling.broker, {
        operationId: 'read',
        name: 'exec',
        arguments: { command: 'obsidian read path=allowed.md' },
        grants: [{ name: 'exec', scope: 'obsidian' }]
      }),
      OPERATION_TIMEOUT_MS
    )
    t.alike(
      read,
      { exitCode: 0, stdout: 'vault-ok\n', stderr: '' },
      'fake CLI reads inside the synthetic vault'
    )

    const created = await bounded(
      invoke(tooling.broker, {
        operationId: 'create',
        name: 'exec',
        arguments: {
          command: 'obsidian create path=created.md content="created by argv"'
        },
        grants: [{ name: 'exec', scope: 'obsidian' }]
      }),
      OPERATION_TIMEOUT_MS
    )
    t.alike(
      created,
      { exitCode: 0, stdout: 'created.md\n', stderr: '' },
      'fake CLI writes inside the synthetic vault'
    )
    t.is(
      await fs.readFile(path.join(vault, 'created.md'), 'utf8'),
      'created by argv',
      'quoted content arrives as one direct argv value'
    )

    const escaped = await bounded(
      invoke(tooling.broker, {
        operationId: 'escape',
        name: 'exec',
        arguments: { command: 'obsidian read path=escape.md' },
        grants: [{ name: 'exec', scope: 'obsidian' }]
      }),
      OPERATION_TIMEOUT_MS
    )
    t.ok(
      typeof escaped === 'object' &&
        escaped !== null &&
        !Array.isArray(escaped) &&
        Reflect.get(escaped, 'exitCode') === 13,
      'Seatbelt denies a vault symlink that resolves outside the approved root'
    )

    const timed = await bounded(
      invoke(tooling.broker, {
        operationId: 'timeout',
        name: 'exec',
        arguments: { command: 'obsidian search query=hang' },
        grants: [{ name: 'exec', scope: 'obsidian' }]
      }),
      OPERATION_TIMEOUT_MS
    )
    t.ok(
      typeof timed === 'object' &&
        timed !== null &&
        !Array.isArray(timed) &&
        typeof Reflect.get(timed, 'error') === 'string' &&
        /timed out/i.test(Reflect.get(timed, 'error')),
      'hung fake CLI is terminated at the configured timeout'
    )

    const obsidianOnly = await createTooling({
      bareExecutable,
      childEntry,
      selectedSkillsForAgent: () => ['obsidian'],
      approval: { approve: async () => true },
      temporaryRoot: root,
      obsidian: {
        executablePath: obsidianExecutable,
        vaultRoot: vault,
        vaultIdentity: 'SyntheticVault',
        timeoutMs: 2_000,
        maxOutputBytes: 64
      }
    })
    try {
      const noWeatherLoopback = await bounded(
        invoke(obsidianOnly.broker, {
          operationId: 'obsidian-only-loopback',
          name: 'exec',
          arguments: {
            command: `obsidian search query=loopback:${alternateLoopbackPort}`
          },
          grants: [{ name: 'exec', scope: 'obsidian' }]
        }),
        START_TIMEOUT_MS
      )
      t.alike(
        noWeatherLoopback,
        {
          exitCode: 0,
          stdout: 'alternate-loopback-denied\n',
          stderr: ''
        },
        'Obsidian-only child has no loopback or network grant'
      )
    } finally {
      await bounded(obsidianOnly.close(), OPERATION_TIMEOUT_MS)
    }

    const activeDuringClose = invoke(tooling.broker, {
      operationId: 'close-active',
      name: 'exec',
      arguments: { command: 'obsidian search query=hang' },
      grants: [{ name: 'exec', scope: 'obsidian' }]
    }).catch((error: Error) => error)
    await delay(25)
    await bounded(tooling.close(), OPERATION_TIMEOUT_MS)
    await bounded(activeDuringClose, OPERATION_TIMEOUT_MS)
    t.ok(true, 'sandbox close terminates and awaits an active fake CLI')
  } finally {
    await bounded(tooling.close(), OPERATION_TIMEOUT_MS)
    await closeTcpServer(alternateLoopback)
    await fs.rm(root, { recursive: true, force: true })
  }
})

function invoke(
  broker: {
    execute(input: object): Promise<unknown>
  },
  input: {
    readonly operationId: string
    readonly name: string
    readonly arguments: Record<string, string>
    readonly grants: readonly {
      readonly name: string
      readonly scope: string | null
    }[]
  }
) {
  return broker.execute({
    agentId: 'desktop-probe-agent',
    runId: 'desktop-probe-run',
    operationId: input.operationId,
    call: {
      id: `${input.operationId}-call`,
      name: input.name,
      arguments: input.arguments
    },
    grants: input.grants,
    signal: new AbortController().signal
  })
}

function delay(milliseconds: number) {
  return new Promise<void>((resolve) => {
    setTimeout(resolve, milliseconds)
  })
}

function closeTcpServer(server: tcp.TCPServer) {
  return new Promise<void>((resolve) => {
    server.close(() => resolve())
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
      () => reject(new Error(`desktop probe exceeded ${milliseconds}ms`)),
      milliseconds
    )
  })
  try {
    return await Promise.race([promise, timeout])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}
