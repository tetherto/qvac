import { CommandError } from './core.js'
import { Prompter, type PromptInput, type PromptOutput } from './prompt.js'

// Output and questions for one command; `tty` says which streams are terminals.
export interface TerminalState {
  stdin: boolean
  stdout: boolean
  stderr: boolean
}
export interface IOOptions {
  tty: TerminalState
  json?: boolean | undefined
  noColor?: boolean | undefined
  nonInteractive?: boolean | undefined
  stopping: Promise<unknown>
}
export class CommandIO {
  stdin: PromptInput
  stdout: PromptOutput
  stderr: PromptOutput
  tty: TerminalState
  interactive: boolean
  color: boolean
  stopping: Promise<unknown>
  _jsonOutput: boolean
  _questions: Prompter | null
  _drawn: boolean

  constructor(
    { stdin, stdout, stderr }: { stdin: PromptInput; stdout: PromptOutput; stderr: PromptOutput },
    { tty, json, noColor, nonInteractive, stopping }: IOOptions
  ) {
    this.stdin = stdin
    this.stdout = stdout
    this.stderr = stderr
    this.tty = tty
    this.interactive = !!(tty.stdin && tty.stdout && !nonInteractive)
    this.color = !!tty.stdout && !noColor
    this.stopping = stopping
    this._jsonOutput = !!json
    this._questions = null
    this._drawn = false
  }

  line(text: string) {
    this._write(this.stdout, text + '\n')
  }

  lines(texts: string[]) {
    for (const text of texts) {
      this.line(text)
    }
  }

  // Human messages; under --json they go to stderr so stdout stays one JSON value per line.
  note(text: string) {
    this._write(this._jsonOutput ? this.stderr : this.stdout, text + '\n')
  }

  json(value: unknown) {
    this._write(this.stdout, JSON.stringify(value) + '\n')
  }

  // One line rewritten in place, such as a progress bar; null takes it away.
  redraw(text: string | null) {
    this._clear()
    if (text === null) {
      return
    }

    this.stdout.write(text)
    this._drawn = true
  }

  // optional: enter alone answers '', and --yes takes that as the answer
  async ask(
    question: string,
    {
      fallback,
      yes,
      optional = false
    }: { fallback?: string | undefined; yes?: boolean | undefined; optional?: boolean } = {}
  ) {
    if (yes && (fallback || optional)) {
      return fallback || ''
    }

    if (!this.interactive) {
      throw new CommandError(`no terminal to ask "${question}" in`, { code: 2 })
    }

    for (;;) {
      const answer = await this._untilStopped(
        this._prompter().ask(question, { fallback: fallback ?? '' })
      )
      if (answer || optional) {
        return answer || ''
      }
    }
  }

  async confirm(
    question: string,
    { yes, unattended = false }: { yes?: boolean | undefined; unattended?: boolean }
  ) {
    if (yes) return true
    if (this.interactive) {
      const answer = await this._untilStopped(this._prompter().ask(question + ' [y/N]'))
      return /^y(es)?$/i.test(answer)
    }

    if (unattended) {
      return true
    }

    throw new CommandError(`pass --yes to answer "${question}" without a terminal.`, { code: 2 })
  }

  close() {
    this._questions?.close()
  }

  _prompter() {
    this._questions ??= new Prompter(this.stdin, this.stdout)
    return this._questions
  }

  _untilStopped<T>(answer: Promise<T>): Promise<T> {
    const cancelled = this.stopping.then(() => {
      throw new CommandError('cancelled.', { code: 130 })
    })

    return Promise.race([answer, cancelled])
  }

  _write(stream: PromptOutput, text: string) {
    if (stream === this.stdout) {
      this._clear()
    }

    stream.write(text)
  }

  _clear() {
    if (!this._drawn) return
    this.stdout.write('\r\x1b[K')
    this._drawn = false
  }
}
