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
        status: 'completed',
        probe: {
          engine: 'llm-llamacpp',
          result: {
            status: 'fits',
            reason: 'fits',
            gpuLayers: 32,
            ctxSize: 4096,
            devices: [
              {
                name: 'Metal',
                totalBytes: 0,
                freeBytes: 0,
                modelBytes: 0,
                contextBytes: 0,
                computeBytes: 0
              }
            ],
            deviceBytes: 0,
            hostBytes: 0,
            trainCtxSize: 8192,
            expertCount: 0
          }
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
