import process from 'bare-process'

type FixtureMode = 'completed' | 'error' | 'hang' | 'abort'

function write(stream: unknown, value: string): void {
  const writable = stream as { write(value: string): void }
  writable.write(value)
}

function parseMode(value: string | undefined): FixtureMode {
  switch (value) {
    case 'completed':
    case 'error':
    case 'hang':
    case 'abort':
      return value
    default:
      throw new TypeError(`Unknown fixture mode: ${String(value)}`)
  }
}

const mode = parseMode(process.argv[2])

switch (mode) {
  case 'completed':
    write(
      process.stdout,
      `${JSON.stringify({
        version: 2,
        status: 'completed',
        result: {
          status: 0,
          fits: true,
          reason: 'fits',
          maxDevices: 1,
          nDevices: 1,
          nGpuDevices: 1,
          nGpuLayers: 32,
          nCtx: 4096,
          nBatch: 512,
          nUbatch: 512,
          tensorSplit: [1],
          buftOverrides: [],
          splitMode: 1,
          mainGpu: 0,
          typeK: 1,
          typeV: 1,
          flashAttnType: 1
        }
      })}\n`
    )
    process.exitCode = 0
    break
  case 'error':
    write(process.stderr, 'fixture failed\n')
    process.exitCode = 17
    break
  case 'hang':
    setInterval(() => {}, 1_000)
    break
  case 'abort':
    process.kill(process.pid, 'SIGABRT')
    break
  default: {
    const exhaustive: never = mode
    write(process.stderr, `Unhandled fixture mode: ${String(exhaustive)}\n`)
    process.exitCode = 2
  }
}
