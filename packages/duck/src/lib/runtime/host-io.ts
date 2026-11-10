// Local filesystem and shell access the UI asks for; the app itself never touches the host.
import b4a from 'b4a'
import fs from 'bare-fs'
import os from 'bare-os'
import path from 'bare-path'
import process from 'bare-process'
import { spawn } from 'bare-subprocess'

const READ_CAP = 512 * 1024
const OUTPUT_CAP = 64 * 1024

export function hostIO(cwd = process.cwd()) {
  const resolve = (file: string) =>
    path.resolve(cwd, file.startsWith('~/') ? path.join(os.homedir(), file.slice(2)) : file)
  return {
    cwd,
    home: os.homedir(),
    readText: (file: string) => readText(resolve(file)),
    async writeFile(
      file: string,
      text: string | import('bare-buffer') | ArrayBufferView<ArrayBufferLike>
    ) {
      const target = resolve(file)
      fs.mkdirSync(path.dirname(target), { recursive: true })
      fs.writeFileSync(target, text)
      return target
    },
    gitBranch: () => gitBranch(cwd),
    editExternal,
    runShell: (command: string, { timeoutMs = 120000 } = {}) =>
      runShell(command, { cwd, timeoutMs })
  }
}

function readText(file: fs.Path) {
  try {
    const data = fs.readFileSync(file) as Uint8Array
    return data.length > READ_CAP ? null : b4a.toString(data, 'utf8')
  } catch {
    return null // a file that does not exist yet has no "before"
  }
}

function gitBranch(cwd: string) {
  for (let dir = cwd; ; dir = path.dirname(dir)) {
    try {
      const head = b4a
        .toString(fs.readFileSync(path.join(dir, '.git', 'HEAD')) as Uint8Array, 'utf8')
        .trim()
      return head.startsWith('ref: refs/heads/') ? head.slice(16) : head.slice(0, 7)
    } catch {}

    if (path.dirname(dir) === dir) {
      return null
    }
  }
}

function editExternal(text: string | import('bare-buffer') | ArrayBufferView<ArrayBufferLike>) {
  const file = path.join(os.tmpdir(), `qvac-draft-${process.pid}.md`)
  fs.writeFileSync(file, text)
  const editor =
    process.env['VISUAL'] ||
    process.env['EDITOR'] ||
    (process.platform === 'win32' ? 'notepad' : 'vi')

  return new Promise<string | null>((resolve) => {
    const child = spawn(
      process.platform === 'win32' ? 'cmd' : '/bin/sh',
      process.platform === 'win32' ? ['/c', `${editor} "${file}"`] : ['-c', `${editor} "$0"`, file],
      { stdio: 'inherit' }
    )
    child.on('exit', () => {
      let edited = null
      try {
        edited = b4a.toString(fs.readFileSync(file) as Uint8Array, 'utf8')
        fs.unlinkSync(file)
      } catch {}

      resolve(edited)
    })
  })
}

function runShell(command: string, { cwd, timeoutMs }: { cwd: string; timeoutMs: number }) {
  return new Promise<{ stdout: string; stderr: string; exitCode: number }>((resolve) => {
    const out: Uint8Array[] = [],
      err: Uint8Array[] = []
    let size = 0
    const shell: [string, string[]] =
      process.platform === 'win32'
        ? ['cmd', ['/c', command]]
        : [process.env['SHELL'] || '/bin/sh', ['-c', command]]
    const child = spawn(shell[0], shell[1], { cwd, stdio: ['ignore', 'pipe', 'pipe'] })
    const keep = (list: Uint8Array[]) => (chunk: unknown) => {
      const data = chunk as Uint8Array
      if (size < OUTPUT_CAP) {
        list.push(data)
      }

      size += data.length
    }
    child.stdout!.on('data', keep(out))
    child.stderr!.on('data', keep(err))
    const timer = setTimeout(() => child.kill(), timeoutMs)
    child.on('exit', (code) => {
      clearTimeout(timer)
      const text = (list: Uint8Array[]) => b4a.toString(b4a.concat(list), 'utf8')
      resolve({
        stdout: text(out) + (size > OUTPUT_CAP ? `\n…[${size - OUTPUT_CAP} bytes omitted]` : ''),
        stderr: text(err),
        exitCode: code ?? 1
      })
    })
  })
}
