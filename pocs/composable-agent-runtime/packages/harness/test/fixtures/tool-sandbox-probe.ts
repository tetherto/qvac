import fs from 'bare-fs/promises'
import path from 'bare-path'
import Pipe from 'bare-pipe'
import process from 'bare-process'
import { spawn } from 'bare-subprocess'
import * as tcp from 'bare-tcp'
import { serveToolSandbox } from '../../index.ts'
import type { HarnessJsonValue } from '../../lib/types.ts'
import type { HarnessStream } from '../../lib/transport.ts'

export default async function start(
  stream: HarnessStream,
  ready?: () => void
) {
  const generation = generationFromArgv()
  const server = serveToolSandbox(stream, {
    generation,
    processId: process.pid,
    executor: {
      async invoke({ toolName, input }) {
        if (toolName !== '__sandbox_probe__') {
          throw new Error(`unknown probe tool: ${toolName}`)
        }
        const resourceFile = requiredString(input.resourceFile)
        const deniedFile = requiredString(input.deniedFile)
        const deniedScratchFile = optionalString(input.deniedScratchFile)
        const holdMs = optionalNumber(input.holdMs)
        const scratchRoot = requiredString(process.env.TMPDIR)
        const loopbackPort = requiredNumber(input.loopbackPort)
        const serviceProbeExecutable = requiredString(
          input.serviceProbeExecutable
        )
        if (holdMs !== undefined) await delay(holdMs)
        const allowedResource = await fs.readFile(resourceFile, 'utf8')
        const deniedFileResult = await deniedRead(deniedFile)
        const deniedScratch = deniedScratchFile
          ? await deniedRead(deniedScratchFile)
          : undefined
        const scratchFile = path.join(scratchRoot, 'probe-write.txt')
        await fs.writeFile(scratchFile, 'scratch-ok\n', { mode: 0o600 })
        const allowedScratch = await fs.readFile(scratchFile, 'utf8')
        const allowedLoopback = await connect(loopbackPort, '127.0.0.1')
        const deniedExternalNetwork = await deniedConnect()
        const deniedSystemFile = await deniedRead('/private/etc/passwd')
        const deniedSystemService = await deniedServiceLookup(
          serviceProbeExecutable
        )
        const deniedUnixSocket = await deniedPipeConnect(
          '/private/var/run/syslog'
        )
        return {
          allowedResource,
          deniedFile: deniedFileResult,
          ...(deniedScratch !== undefined ? { deniedScratch } : {}),
          allowedScratch,
          allowedLoopback,
          deniedExternalNetwork,
          deniedSystemFile,
          deniedSystemService,
          deniedUnixSocket
        }
      }
    }
  })
  ready?.()
  return async function stop() {
    server.close()
  }
}

async function deniedRead(file: string) {
  try {
    await fs.readFile(file, 'utf8')
    return false
  } catch (error) {
    return deniedError(error)
  }
}

function connect(port: number, host: string) {
  return new Promise<boolean>((resolve) => {
    const socket = tcp.createConnection(port, host)
    let settled = false
    const finish = (result: boolean) => {
      if (settled) return
      settled = true
      socket.destroy()
      resolve(result)
    }
    socket.once('connect', () => finish(true))
    socket.once('error', () => finish(false))
    socket.setTimeout(500, () => finish(false))
  })
}

function deniedConnect() {
  return new Promise<boolean>((resolve) => {
    const socket = tcp.createConnection({
      host: '198.51.100.1',
      port: 9,
      timeout: 300
    })
    let settled = false
    const finish = (result: boolean) => {
      if (settled) return
      settled = true
      socket.destroy()
      resolve(result)
    }
    socket.once('connect', () => finish(false))
    socket.once('error', (error) => finish(deniedError(error)))
    socket.once('timeout', () => finish(false))
  })
}

function deniedPipeConnect(socketPath: string) {
  return new Promise<boolean>((resolve) => {
    const pipe = Pipe.createConnection(socketPath)
    let settled = false
    const finish = (result: boolean) => {
      if (settled) return
      settled = true
      pipe.destroy()
      resolve(result)
    }
    pipe.once('connect', () => finish(false))
    pipe.once('error', (error) => finish(deniedError(error)))
    setTimeout(() => finish(false), 300)
  })
}

function deniedServiceLookup(executable: string) {
  return new Promise<boolean>((resolve, reject) => {
    const child = spawn(executable, [], {
      env: {},
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe']
    })
    let stdout = ''
    let stderr = ''
    child.stdout?.on('data', (data) => {
      stdout += String(data)
    })
    child.stderr?.on('data', (data) => {
      stderr += String(data)
    })
    child.once('exit', (code, signal) => {
      if (code !== 0 || signal !== null) {
        reject(
          new Error(
            `service probe failed (${signal ?? `code ${code}`}): ${stderr.trim()}`
          )
        )
        return
      }
      const result = Number(stdout.trim())
      if (!Number.isSafeInteger(result)) {
        reject(new Error(`service probe returned invalid result: ${stdout}`))
        return
      }
      resolve(result !== 0)
    })
  })
}

function deniedError(error: unknown) {
  if (typeof error !== 'object' || error === null) return false
  const code = Reflect.get(error, 'code')
  return code === 'EACCES' || code === 'EPERM'
}

function generationFromArgv() {
  const raw = process.argv
    .find((value) => value.startsWith('--sandbox-generation='))
    ?.slice('--sandbox-generation='.length)
  const generation = Number(raw)
  if (!Number.isSafeInteger(generation) || generation < 1) {
    throw new Error('probe requires a positive sandbox generation')
  }
  return generation
}

function requiredString(value: HarnessJsonValue | undefined) {
  if (typeof value !== 'string') throw new Error('probe expected a string')
  return value
}

function requiredNumber(value: HarnessJsonValue | undefined) {
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) {
    throw new Error('probe expected an integer')
  }
  return value
}

function optionalString(value: HarnessJsonValue | undefined) {
  if (value === undefined) return undefined
  return requiredString(value)
}

function optionalNumber(value: HarnessJsonValue | undefined) {
  if (value === undefined) return undefined
  return requiredNumber(value)
}

function delay(milliseconds: number) {
  return new Promise<void>((resolve) => {
    setTimeout(resolve, milliseconds)
  })
}
