import fs = require('bare-fs')
import path = require('bare-path')
import { spawn, type Subprocess } from 'bare-subprocess'

import {
  encodeWorkerRequest,
  parseWorkerEvent,
  type RuntimeConfig,
  type WorkerEvent,
  type WorkerRequest
} from './protocol'

export class MiniMaxDiffusersWorker {
  private child: Subprocess | null = null
  private pending = ''

  constructor (
    private readonly pythonPath: string,
    private readonly onEvent: (event: WorkerEvent) => void
  ) {
    if (!path.isAbsolute(pythonPath) || !fs.existsSync(pythonPath)) {
      throw new TypeError('pythonPath must be an existing absolute path')
    }
  }

  start (): void {
    if (this.child !== null) return
    const child = spawn(this.pythonPath, ['-m', 'qvac_audiogen_diffusers'], {
      stdio: ['overlapped', 'overlapped', 'overlapped']
    })
    if (child.stdin === null || child.stdout === null) {
      child.kill()
      throw new Error('failed to create Python worker pipes')
    }
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk: unknown) => this.consume(String(chunk)))
    child.on('exit', () => {
      this.child = null
    })
    this.child = child
  }

  load (config: RuntimeConfig): void {
    this.send({ version: 1, op: 'load', config })
  }

  generate (request: Omit<Extract<WorkerRequest, { op: 'generate' }>, 'version' | 'op'>): void {
    this.send({ version: 1, op: 'generate', ...request })
  }

  cancel (requestId: string): void {
    this.send({ version: 1, op: 'cancel', requestId })
  }

  unload (): void {
    this.send({ version: 1, op: 'unload' })
  }

  destroy (): void {
    if (this.child === null) return
    this.child.kill()
    this.child = null
  }

  private send (request: WorkerRequest): void {
    if (this.child?.stdin === null || this.child === null) {
      throw new Error('Python worker is not running')
    }
    this.child.stdin.write(encodeWorkerRequest(request))
  }

  private consume (chunk: string): void {
    this.pending += chunk
    for (;;) {
      const newline = this.pending.indexOf('\n')
      if (newline < 0) return
      const line = this.pending.slice(0, newline)
      this.pending = this.pending.slice(newline + 1)
      if (line.length === 0) continue
      this.onEvent(parseWorkerEvent(JSON.parse(line)))
    }
  }
}
