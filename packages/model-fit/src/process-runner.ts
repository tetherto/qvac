/* eslint-disable @typescript-eslint/no-require-imports -- Bare modules expose CommonJS export shapes. */
import fs = require('bare-fs')
import path = require('bare-path')
import processModule = require('bare-process')
/* eslint-enable @typescript-eslint/no-require-imports */

import {
  runFitProcessLine,
  type FitProcessFit,
  type FitProcessLlamaFit,
  type FitProcessOutcome
} from './process-internal'
import { FIT_PROCESS_MAX_REQUEST_BYTES } from './process'
import type { FitLlamaResult } from './process'

interface RunnerInput {
  setEncoding(encoding: 'utf8'): void
  on(event: 'data', listener: (chunk: string) => void): void
  on(event: 'end', listener: () => void): void
  on(event: 'error', listener: (error: Error) => void): void
  resume(): void
  pause(): void
}

interface RunnerOutput {
  write(chunk: string, callback: (error: Error | null) => void): boolean
}

interface RunnerProcess {
  stdin: RunnerInput
  stdout: RunnerOutput
  stderr: RunnerOutput
  exit(code: number): never
}

const process = processModule as unknown as RunnerProcess
const PACKAGED_BACKENDS_DIR = path.join(__dirname, 'prebuilds')

function exitAfterWriteError (error: Error): void {
  process.stderr.write(`model-fit process runner failed to write its response: ${error.message}\n`, () => {
    process.exit(2)
  })
}

function writeOutcome (outcome: FitProcessOutcome): void {
  // One shot: stop reading before replying, so a still-open stdin cannot hold
  // the child open once the response has been flushed.
  process.stdin.pause()
  process.stdout.write(outcome.responseLine, (error: Error | null) => {
    if (error !== null) {
      exitAfterWriteError(error)
      return
    }
    process.exit(outcome.exitCode)
  })
}

// Deliberately not a top-level import: loading the addon registers the ggml
// backends, which is the very work this boundary exists to keep disposable. A
// malformed or oversized request is answered without ever touching native code.
function fit (config: Parameters<FitProcessFit>[0]): ReturnType<FitProcessFit> {
  // eslint-disable-next-line @typescript-eslint/no-require-imports -- see above
  return (require('./index') as { fitParams: FitProcessFit }).fitParams(config)
}

function fitLlama (...args: Parameters<FitProcessLlamaFit>): ReturnType<FitProcessLlamaFit> {
  const [loadKind, config] = args
  // `./binding-internal`, not `./binding`: the raw load-config fitter is not
  // public API, and `./binding.js` is a public export.
  // eslint-disable-next-line @typescript-eslint/no-require-imports -- native binding is disposable here.
  const binding = require('./binding-internal') as {
    llamaConfigFit(request: {
      loadKind: Parameters<FitProcessLlamaFit>[0]
      modelPath: string
      params: Record<string, string>
      backendsDir?: string
      marginMiB?: number
      nCtxMin?: number
    }): FitLlamaResult
  }
  let resolved = config
  if (config.backendsDir === undefined) {
    try {
      if (fs.statSync(PACKAGED_BACKENDS_DIR).isDirectory()) {
        resolved = { ...config, backendsDir: PACKAGED_BACKENDS_DIR }
      }
    } catch {
      // Statically linked builds do not need a packaged backends directory.
    }
  }
  return binding.llamaConfigFit({ loadKind, ...resolved })
}

function finish (line: string): void {
  writeOutcome(runFitProcessLine(line, fit, fitLlama))
}

let input = ''
let finished = false

process.stdin.setEncoding('utf8')
process.stdin.on('data', (chunk: string) => {
  if (finished) return
  input += chunk
  if (Buffer.byteLength(input, 'utf8') > FIT_PROCESS_MAX_REQUEST_BYTES) {
    finished = true
    finish(input)
    return
  }

  const newline = input.indexOf('\n')
  if (newline === -1) return
  finished = true
  finish(input.slice(0, newline))
})
process.stdin.on('end', () => {
  if (finished) return
  finished = true
  finish(input)
})
// A parent that dies mid-request breaks the pipe; diagnose and exit here so the
// failure stays inside the disposable child instead of crashing it unexplained.
process.stdin.on('error', (error: Error) => {
  if (finished) return
  finished = true
  process.stderr.write(`model-fit process runner failed to read its request: ${error.message}\n`, () => {
    process.exit(2)
  })
})
process.stdin.resume()
