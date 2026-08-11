// Consumer-side type test for the process boundary, the counterpart to
// narrowing.test-d.ts. Compiling `process.d.ts` on its own only proves the
// declaration parses; this proves the response union narrows the way a
// supervisor would rely on. Type-checked by `npm run test:dts`, never executed.

import {
  encodeFitProcessRequest,
  parseFitProcessResponse,
  resolveFitProcessRunnerPath,
  FIT_PROCESS_MAX_REQUEST_BYTES,
  FIT_PROCESS_MAX_RESPONSE_BYTES
} from '../../process'
import type { FitProcessRequest, FitProcessResponse } from '../../process'
import { FIT_STATUS } from '../../index'
import type { FitConfig, FitResult } from '../../index'

declare function assertNever (value: never): never

// A supervisor holds the two ends of the pipe: a `FitConfig` in, an opaque
// parsed JSON value back out.
const config: FitConfig = { modelPath: '/model.gguf', nCtx: 4096 }
const requestLine: string = encodeFitProcessRequest(config)
const runnerPath: string = resolveFitProcessRunnerPath()
void requestLine
void runnerPath

// @ts-expect-error the codec takes a config, not an already-wrapped envelope
encodeFitProcessRequest({ version: 1, config })

// @ts-expect-error modelPath is required
encodeFitProcessRequest({ nCtx: 4096 })

const response: FitProcessResponse = parseFitProcessResponse(null as unknown)

if (response.status === 'completed') {
  // A completed response carries a full FitResult, which then narrows on its
  // own status exactly as an in-process `fitParams` call would.
  const result: FitResult = response.result
  if (result.status === FIT_STATUS.SUCCESS) {
    const ctx: number = result.nCtx
    void ctx
  }
  void result

  // @ts-expect-error `error` belongs to the other branch
  const error = response.error
  void error
} else {
  const name: string = response.error.name
  const message: string = response.error.message
  void name
  void message

  // @ts-expect-error `result` belongs to the other branch
  const result = response.result
  void result
}

// Exhaustiveness: adding a status without handling it must fail to compile.
function describe (r: FitProcessResponse): string {
  switch (r.status) {
    case 'completed': return r.result.reason
    case 'invocation-error': return r.error.message
    default: return assertNever(r)
  }
}
void describe

// The protocol version is a literal, so a request cannot be built against a
// version this package does not speak.
const request: FitProcessRequest = { version: 1, config }
void request

// @ts-expect-error the version is pinned to the one this package implements
const stale: FitProcessRequest = { version: 2, config }
void stale

// Size bounds are readable so a caller can pre-check before spawning.
const maxRequest: number = FIT_PROCESS_MAX_REQUEST_BYTES
const maxResponse: number = FIT_PROCESS_MAX_RESPONSE_BYTES
void maxRequest
void maxResponse
