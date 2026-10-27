import { emitKeypressEvents, type Key } from 'node:readline'
import { spawn } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { Editor } from '../../product/editor.js'
import { wrap } from '../../product/text.js'

interface Context {
  signal?: AbortSignal
}
interface Choice<T> {
  name: string
  value: T
  description?: string
}
interface Options<T> {
  message: string
  choices?: Choice<T>[]
  source?: (term: string | undefined) => Choice<T>[] | Promise<Choice<T>[]>
  pageSize?: number
  default?: string
  validate?: (value: string) => string | boolean | Promise<string | boolean>
}

function cancelled(name: 'AbortPromptError' | 'ExitPromptError'): Error {
  return Object.assign(
    new Error(name === 'AbortPromptError' ? 'Prompt aborted' : 'Prompt cancelled'),
    { name }
  )
}

// Only the configure wizard's five operations. Keep terminal ownership local to
// each question so editor subprocesses and the shell receive a restored TTY.
function prompt<T>(
  mode: 'select' | 'search' | 'input',
  options: Options<T>,
  context: Context = {}
): Promise<T | string> {
  if (context.signal?.aborted) return Promise.reject(cancelled('AbortPromptError'))
  if (!process.stdin.isTTY) return Promise.reject(new Error('This prompt requires a terminal'))
  const stdin = process.stdin,
    stdout = process.stdout
  const wasRaw = stdin.isRaw
  const edit = new Editor()
  let defaultValue = mode === 'input' ? (options.default ?? '') : ''
  let choices = options.choices ?? [],
    selected = 0,
    drawn = 0,
    error = '',
    settled = false,
    busy = false,
    revision = 0
  emitKeypressEvents(stdin)
  stdin.setRawMode(true)
  stdin.resume()
  stdout.write('\x1b[?25l')

  return new Promise((resolve, reject) => {
    const clear = () => {
      if (drawn) stdout.write(`\x1b[${drawn}A\r\x1b[J`)
      drawn = 0
    }
    const render = () => {
      if (settled) return
      const width = Math.max(1, (stdout.columns || 80) - 1)
      const height = Math.max(1, (stdout.rows || 24) - 1)
      const rowsOf = (text: string) => text.split('\n').flatMap((line) => wrap(line, width))
      const message = rowsOf(options.message)
      const lines = message.slice(0, Math.max(1, Math.floor(height / 3)))
      const errorRows = error ? rowsOf(error).slice(0, 1) : []
      if (mode !== 'select') {
        const value =
          !edit.value && defaultValue
            ? `(${defaultValue}; Tab to edit)`
            : (edit.rows(width - 2, 1)[0] ?? '')
        lines.push(...rowsOf(`> ${value}`).slice(0, 1))
      }
      if (mode !== 'input') {
        const remaining = Math.max(1, height - lines.length - errorRows.length)
        const description = rowsOf(choices[selected]?.description ?? '').slice(
          0,
          Math.min(Math.floor(height / 3), remaining - 1)
        )
        const budget = Math.max(1, remaining - description.length)
        const rowFor = (index: number) =>
          rowsOf(`${index === selected ? '❯' : ' '} ${choices[index]!.name}`)
        const visible = choices.length
          ? rowFor(selected).slice(0, budget)
          : [busy ? 'Searching…' : 'No matches']
        let start = selected,
          end = selected + 1,
          count = 1
        const size = options.pageSize ?? 7
        while (end < choices.length && count < size) {
          const rows = rowFor(end)
          if (visible.length + rows.length > budget) break
          visible.push(...rows)
          end++
          count++
        }
        while (start > 0 && count < size) {
          const rows = rowFor(start - 1)
          if (visible.length + rows.length > budget) break
          visible.unshift(...rows)
          start--
          count++
        }
        lines.push(...visible, ...description)
      }
      lines.push(...errorRows)
      clear()
      const visible = lines.slice(0, height)
      stdout.write(visible.join('\n') + '\n')
      drawn = visible.length
    }
    const cleanup = () => {
      settled = true
      stdin.off('keypress', keypress)
      stdin.off('end', ended)
      stdout.off('resize', render)
      context.signal?.removeEventListener('abort', aborted)
      stdin.setRawMode(wasRaw)
      stdin.pause()
      stdout.write('\x1b[?25h')
    }
    const finish = (value: T | string) => {
      clear()
      cleanup()
      resolve(value)
    }
    const fail = (reason: unknown) => {
      clear()
      cleanup()
      reject(reason)
    }
    const aborted = () => fail(cancelled('AbortPromptError'))
    const ended = () => fail(cancelled('ExitPromptError'))
    const search = async () => {
      const current = ++revision
      busy = true
      try {
        const found = await options.source!(edit.value || undefined)
        if (settled || current !== revision) return
        choices = found
        selected = 0
        busy = false
        render()
      } catch (cause) {
        if (!settled && current === revision) fail(cause)
      }
    }
    const submit = async () => {
      if (busy) return
      if (mode !== 'input') {
        const choice = choices[selected]
        if (choice) finish(choice.value)
        return
      }
      busy = true
      try {
        const answer = edit.value || defaultValue
        const valid = (await options.validate?.(answer)) ?? true
        if (settled) return
        if (valid === true) finish(answer)
        else {
          error = typeof valid === 'string' ? valid : 'Please enter a valid value'
          busy = false
          render()
        }
      } catch (cause) {
        if (!settled) fail(cause)
      }
    }
    const keypress = (text: string | undefined, key: Key = {}) => {
      if (settled) return
      if (key.ctrl && key.name === 'c') return fail(cancelled('ExitPromptError'))
      if (key.name === 'escape' || (busy && mode === 'input')) return
      if (key.name === 'return' || key.name === 'enter') {
        void submit()
        return
      }
      if (
        mode !== 'input' &&
        (key.name === 'up' ||
          key.name === 'down' ||
          key.name === 'pageup' ||
          key.name === 'pagedown')
      ) {
        const step = key.name.startsWith('page') ? (options.pageSize ?? 7) : 1
        const delta = key.name === 'up' || key.name === 'pageup' ? -step : step
        selected = choices.length ? (selected + delta + choices.length * step) % choices.length : 0
        render()
        return
      }
      if (mode === 'select') {
        if (text && !key.ctrl && !key.meta) {
          const next = choices.findIndex(
            (choice, index) =>
              index > selected && choice.name.toLowerCase().startsWith(text.toLowerCase())
          )
          const first = choices.findIndex((choice) =>
            choice.name.toLowerCase().startsWith(text.toLowerCase())
          )
          if (next >= 0 || first >= 0) selected = next >= 0 ? next : first
          render()
        }
        return
      }
      if (mode === 'input' && !edit.value) {
        if (key.name === 'backspace') defaultValue = ''
        if (key.name === 'tab') {
          edit.set(defaultValue)
          defaultValue = ''
          render()
          return
        }
      }
      const name = `${key.ctrl ? 'ctrl+' : key.meta ? 'alt+' : ''}${key.name ?? ''}`
      const handled = edit.key({
        name: key.name ?? '',
        sequence: key.sequence ?? '',
        ctrl: !!key.ctrl,
        meta: !!key.meta,
        is: (...names) => names.includes(name)
      })
      if (!handled && text && !key.ctrl && !key.meta) edit.insert(text)
      error = ''
      if (mode === 'search') void search()
      else render()
    }
    stdin.on('keypress', keypress)
    stdin.once('end', ended)
    stdout.on('resize', render)
    context.signal?.addEventListener('abort', aborted, { once: true })
    if (mode === 'search') void search()
    render()
  })
}

export const select = <T>(options: Options<T> & { choices: Choice<T>[] }, context?: Context) =>
  prompt('select', options, context) as Promise<T>
export const search = <T>(
  options: Options<T> & { source: NonNullable<Options<T>['source']> },
  context?: Context
) => prompt('search', options, context) as Promise<T>
export const input = (options: Options<string>, context?: Context) =>
  prompt('input', options, context)
export async function confirm(
  options: { message: string; default?: boolean },
  context?: Context
): Promise<boolean> {
  const answer = await input(
    {
      message: `${options.message} ${options.default ? '(Y/n)' : '(y/N)'}`,
      validate: (value) => /^(?:y(?:es)?|n(?:o)?)?$/i.test(value.trim()) || 'Enter yes or no'
    },
    context
  )
  return answer.trim() ? /^y/i.test(answer.trim()) : (options.default ?? false)
}

// Parse quoted executable paths and arguments without invoking a shell. Keep
// ordinary Windows backslashes; only escape quotes, whitespace or backslashes.
export function editorCommand(command: string, platform: string = process.platform): string[] {
  const args: string[] = []
  let part = '',
    quote = '',
    started = false
  for (let i = 0; i < command.length; i++) {
    const char = command[i]!
    if (
      char === '\\' &&
      quote !== "'" &&
      (platform !== 'win32' || command[i + 1] === '"') &&
      /[\\\s"']/.test(command[i + 1] ?? '')
    ) {
      part += command[++i]
      started = true
    } else if (quote) {
      if (char === quote) quote = ''
      else part += char
      started = true
    } else if (char === '"' || char === "'") {
      quote = char
      started = true
    } else if (/\s/.test(char)) {
      if (started) {
        args.push(part)
        part = ''
        started = false
      }
    } else {
      part += char
      started = true
    }
  }
  if (quote) throw new Error('Unclosed quote in EDITOR/VISUAL')
  if (started) args.push(part)
  if (!args[0]) throw new Error('EDITOR/VISUAL is empty')
  return args
}

export async function editor(options: {
  message: string
  default?: string
  postfix?: string
}): Promise<string> {
  await input({ message: `${options.message} — press Enter to open your editor` })
  const dir = await mkdtemp(path.join(os.tmpdir(), 'qvac-editor-'))
  const file = path.join(
    dir,
    `entry${(options.postfix ?? '.txt').replace(/[^a-zA-Z0-9_.-]/g, '_')}`
  )
  try {
    await writeFile(file, options.default ?? '', { encoding: 'utf8', mode: 0o600, flag: 'wx' })
    const [command, ...args] = editorCommand(
      process.env['VISUAL'] ??
        process.env['EDITOR'] ??
        (process.platform === 'win32' ? 'notepad' : 'vim')
    )
    await new Promise<void>((resolve, reject) => {
      const child = spawn(command!, [...args, file], { stdio: 'inherit', shell: false })
      let interrupted = false
      let killTimer: ReturnType<typeof setTimeout> | undefined
      const interrupt = () => {
        interrupted = true
        child.kill('SIGINT')
        killTimer ??= setTimeout(() => child.kill('SIGKILL'), 1000)
      }
      const cleanup = () => {
        process.off('SIGINT', interrupt)
        if (killTimer) clearTimeout(killTimer)
      }
      process.on('SIGINT', interrupt)
      child.once('error', (error) => {
        cleanup()
        reject(error)
      })
      child.once('exit', (code, signal) => {
        cleanup()
        if (interrupted || signal === 'SIGINT' || code === 130) reject(cancelled('ExitPromptError'))
        else if (code !== 0) reject(new Error(`Editor exited ${signal ?? code}`))
        else resolve()
      })
    })
    const bytes = await readFile(file)
    const encoding =
      bytes[0] === 0xff && bytes[1] === 0xfe
        ? 'utf-16le'
        : bytes[0] === 0xfe && bytes[1] === 0xff
          ? 'utf-16be'
          : 'utf-8'
    return new TextDecoder(encoding).decode(bytes)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}
