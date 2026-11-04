import test from 'brittle'
import fs from 'node:fs'
import net from 'node:net'
import path from 'node:path'
import { createIPCSocketPath, removeIPCSocketPath } from '@/client/rpc/ipc-socket-path'

const isWindows = process.platform === 'win32'

function listen(socketPath: string) {
  return new Promise<net.Server>((resolve, reject) => {
    const server = net.createServer((socket) => socket.end())
    server.once('error', reject)
    server.listen(socketPath, () => resolve(server))
  })
}

function connect(socketPath: string) {
  return new Promise<void>((resolve, reject) => {
    const socket = net.connect(socketPath, () => {
      socket.end()
      resolve()
    })
    socket.once('error', reject)
  })
}

function closeServer(server: net.Server) {
  return new Promise<void>((resolve) => server.close(() => resolve()))
}

void test(
  'IPC socket directory is private to the owner under a permissive umask',
  { skip: isWindows },
  async function (t) {
    const previousUmask = process.umask(0o000)
    let socketPath: string
    try {
      socketPath = createIPCSocketPath()
    } finally {
      process.umask(previousUmask)
    }
    t.teardown(() => removeIPCSocketPath(socketPath))

    const dirMode = fs.statSync(path.dirname(socketPath)).mode & 0o777
    t.is(dirMode, 0o700, `expected 0700, got ${dirMode.toString(8)}`)
  }
)

void test(
  'the owner can listen and connect on the IPC socket path',
  { skip: isWindows },
  async function (t) {
    const socketPath = createIPCSocketPath()
    t.teardown(() => removeIPCSocketPath(socketPath))

    const server = await listen(socketPath)
    t.teardown(() => closeServer(server))

    await t.execution(connect(socketPath))
  }
)

void test(
  'removing the IPC socket path deletes the socket and its directory',
  { skip: isWindows },
  async function (t) {
    const socketPath = createIPCSocketPath()
    const server = await listen(socketPath)
    await closeServer(server)

    removeIPCSocketPath(socketPath)

    t.absent(fs.existsSync(socketPath))
    t.absent(fs.existsSync(path.dirname(socketPath)))
    t.execution(() => removeIPCSocketPath(socketPath))
  }
)

void test('the IPC endpoint on Windows is a named pipe', { skip: !isWindows }, function (t) {
  t.ok(createIPCSocketPath().startsWith('\\\\.\\pipe\\qvac-worker-'))
})
