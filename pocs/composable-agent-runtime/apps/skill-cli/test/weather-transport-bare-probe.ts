import AbortController from 'bare-abort-controller'
import Buffer from 'bare-buffer'
import fs from 'bare-fs/promises'
import process from 'bare-process'
import { requestPinnedHttps } from '../lib/weather-transport.ts'

const input = parseArgs(process.argv.slice(2))
const controller = new AbortController()
if (input.mode === 'cancel') {
  setTimeout(() => controller.abort('test cancellation'), 50)
}

try {
  const ca = await fs.readFile(input.ca)
  const response = await requestPinnedHttps({
    url: new URL(
      `https://${input.mode === 'wrong-identity' ? 'wrong.example' : 'wttr.in'}/${input.mode}`
    ),
    address: { address: '127.0.0.1', family: 4 },
    port: input.port,
    ca:
      typeof ca === 'string'
        ? Buffer.from(ca)
        : Buffer.from(ca.buffer, ca.byteOffset, ca.byteLength),
    signal: controller.signal,
    maxResponseBytes: 8_192
  })
  await emit({ status: 'success', response })
  process.exit(0)
} catch (error) {
  await emit({
    status: 'error',
    name: error instanceof Error ? error.name : 'Error',
    message: error instanceof Error ? error.message : String(error)
  })
  process.exit(0)
}

function parseArgs(args: readonly string[]) {
  const values = new Map(
    args.map((argument) => {
      const separator = argument.indexOf('=')
      if (separator < 1) throw new Error(`invalid argument: ${argument}`)
      return [
        argument.slice(2, separator),
        argument.slice(separator + 1)
      ]
    })
  )
  const mode = values.get('mode')
  const ca = values.get('ca')
  const output = values.get('output')
  const port = Number(values.get('port'))
  if (
    (mode !== 'success' &&
      mode !== 'cancel' &&
      mode !== 'wrong-identity') ||
    !ca ||
    !output ||
    !Number.isSafeInteger(port) ||
    port < 1 ||
    port > 65_535
  ) {
    throw new Error('probe requires valid mode, ca, and port arguments')
  }
  return { mode, ca, output, port }
}

async function emit(value: object) {
  const serialized = JSON.stringify(value)
  await fs.writeFile(input.output, serialized)
  console.log(serialized)
}
