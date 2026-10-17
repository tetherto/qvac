import tcp from 'bare-tcp'
import os from 'bare-os'
import { runEntry } from '@/worker/shim'

// Run as `bare <tcp-shim> <entry> <port>` by a client that listens on the
// loopback port and passes no IPC pipe. Plain `bare` has no `Bare.IPC`;
// bare-sidecar's runtime opens it on that missing pipe and exits when it
// closes unless something else listens for the close.
Bare.IPC?.on('close', () => {}).on('error', () => {})

const [, , entryPath, port] = Bare.argv

const socket = await new Promise<tcp.TCPSocket>((resolve, reject) => {
  const connection = tcp.createConnection(Number(port), '127.0.0.1', () => resolve(connection))
  connection.once('error', reject)
})

// A client that asked for token-v1 authentication accepts the connection only
// after this line, which proves the worker is the child it started. Unset so
// processes the worker spawns do not inherit it.
const token = os.getEnv('QVAC_IPC_AUTH_TOKEN')
if (token !== undefined) os.unsetEnv('QVAC_IPC_AUTH_TOKEN')
if (token) socket.write(`${token}\n`)

await runEntry(socket, entryPath!)
