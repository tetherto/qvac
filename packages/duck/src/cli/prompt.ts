import b4a from 'b4a'

// Plain line questions on a cooked terminal: the shell's own line editing, no TUI.
export interface PromptInput {
  on(event: string, listener: (...args: never[]) => void): unknown
  off(event: string, listener: (...args: never[]) => void): unknown
  pause(): unknown
}
export interface PromptOutput {
  write(text: string): unknown
  columns?: number | undefined
}
export class Prompter {
  input: PromptInput
  output: PromptOutput
  _buffered: string
  _waiting: { resolve(answer: string): void; reject(error: Error): void } | null
  _ended: boolean
  _onData: (data: Uint8Array | string) => void
  _onEnd: () => void

  constructor(input: PromptInput, output: PromptOutput) {
    this.input = input
    this.output = output
    this._buffered = ''
    this._waiting = null
    this._ended = false
    this._onData = (data: Uint8Array | string) => {
      this._buffered += typeof data === 'string' ? data : b4a.toString(data)
      this._flush()
    }
    this._onEnd = () => {
      this._ended = true
      this._flush()
    }

    input.on('data', this._onData)
    input.on('end', this._onEnd)
  }

  ask(question: string, { fallback = '' } = {}) {
    const asked = fallback ? `${question} [${fallback}]` : question
    this.output.write(/[?\]]$/.test(asked) && !fallback ? `${asked} ` : `${asked}: `)

    return new Promise<string>((resolve, reject) => {
      this._waiting = { resolve: (answer) => resolve(answer || fallback), reject }
      this._flush()
    })
  }

  close() {
    this.input.off('data', this._onData)
    this.input.off('end', this._onEnd)
    this.input.pause()
  }

  _flush() {
    if (!this._waiting) return
    const at = this._buffered.indexOf('\n')
    if (at === -1 && !this._ended) {
      return
    }

    const line = at === -1 ? this._buffered : this._buffered.slice(0, at)
    this._buffered = at === -1 ? '' : this._buffered.slice(at + 1)
    const { resolve, reject } = this._waiting
    this._waiting = null
    if (at === -1 && !line) {
      reject(new Error('No answer: input closed'))
    } else {
      resolve(line.replace(/\r$/, '').trim())
    }
  }
}
