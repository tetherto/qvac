import type { LaunchOptions } from '../../lib/types.js'
import type { Connection } from '../app-types.js'
import type { hostIO } from '../../lib/runtime/host-io.js'
import { readPluginState, writePluginState } from '@qvac/cli-kit/config'
import type { ChatOptions } from './app.js'
import type { PrintIO } from '../print.js'
import process from 'bare-process'
import fs from 'bare-fs'
import path from 'bare-path'
import os from 'bare-os'
import b4a from 'b4a'
import { spawn } from 'bare-subprocess'
import tty from 'bare-tty'
import { listFiles } from '../../lib/runtime/files.js'
import { loadTemplates, loadContextFiles, contextPreamble } from '../../lib/runtime/resources.js'
import { screens } from '../screens.js'
import { pluginsScreen } from '../plugins-screen.js'
import { runPrint } from '../print.js'

function readClipboard() {
  const commands: [string, string[]][] =
    process.platform === 'darwin'
      ? [['pbpaste', []]]
      : [
          ['wl-paste', ['--no-newline']],
          ['xclip', ['-o', '-selection', 'clipboard']],
          ['xsel', ['--clipboard', '--output']]
        ]
  return new Promise<string>((resolve, reject) => {
    const attempt = (i: number) => {
      if (i >= commands.length) {
        reject(new Error('no clipboard command available'))
        return
      }

      const [cmd, args] = commands[i]!
      let child
      try {
        child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'ignore'] })
      } catch {
        attempt(i + 1)
        return
      }

      const out: Uint8Array[] = []
      child.stdout!.on('data', (data) => out.push(data as Uint8Array))
      child.on('error', () => attempt(i + 1))
      child.on('exit', (code) =>
        code === 0 ? resolve(b4a.concat(out).toString()) : attempt(i + 1)
      )
    }
    attempt(0)
  })
}

const MIME_TYPES = new Map([
  ['.png', 'image/png'],
  ['.jpg', 'image/jpeg'],
  ['.jpeg', 'image/jpeg'],
  ['.gif', 'image/gif'],
  ['.webp', 'image/webp'],
  ['.heic', 'image/heic'],
  ['.heif', 'image/heif'],
  ['.pdf', 'application/pdf'],
  ['.txt', 'text/plain'],
  ['.md', 'text/markdown'],
  ['.json', 'application/json']
])
// the engine's own cap (lib/core/files/attachments.ts); a lower one here refused files it takes
const MAX_ATTACHMENT_BYTES = 100 * 1024 * 1024

// raw image data on the clipboard has no portable tty-side accessor, so only file paths attach
async function resolvePastedFile() {
  const text = (await readClipboard()).trim()
  if (!text || text.includes('\n')) {
    return null
  }

  const file = expandFilePath(text)
  let stat
  try {
    stat = fs.statSync(file)
  } catch {
    return null
  }

  if (!stat.isFile()) {
    return null
  }

  return fileToAttachment(file, stat)
}

// `/attach` resolver: a named path -> attachment; throws on a bad path.
function resolveFileAttachment(pathString: string) {
  return fileToAttachment(expandFilePath(pathString))
}

function expandFilePath(text: string) {
  const file = text.startsWith('file://') ? decodeURI(text.slice('file://'.length)) : text
  return file.startsWith('~/') ? path.join(os.homedir(), file.slice(2)) : file
}

function fileToAttachment(file: string, stat = fs.statSync(file)) {
  if (!stat.isFile()) throw new Error('not a regular file')
  if (stat.size > MAX_ATTACHMENT_BYTES) {
    throw new Error(`file too large (${MAX_ATTACHMENT_BYTES / (1024 * 1024)}MB cap)`)
  }

  return {
    fileName: path.basename(file),
    mimeType: MIME_TYPES.get(path.extname(file).toLowerCase()) ?? 'application/octet-stream',
    data: fs.readFileSync(file) as Uint8Array
  }
}

// The chat's half of the app options: attachments, the external editor, files, templates,
// the agent screens and plugin state.
export function chatOptions(
  options: LaunchOptions,
  io: ReturnType<typeof hostIO>,
  program: { input: { destroy(): void } }
): Partial<ChatOptions> {
  return {
    resolveFileAttachment,
    resolvePastedFile,
    // a paused tty stream keeps its native read, so the editor and the TUI would race for keys
    editExternal: async (text) => {
      program.input.destroy()
      try {
        return await io.editExternal(text)
      } finally {
        program.input = new tty.ReadStream(0)
      }
    },
    listFiles: () => listFiles(io.cwd),
    loadTemplates: () => loadTemplates({ cwd: io.cwd }),
    loadContext: () => loadContextFiles({ cwd: io.cwd }),
    screens: { ...screens, plugins: pluginsScreen },
    readPluginState: () => readPluginState(options.dataDir!, fs),
    writePluginState: (state) => writePluginState(options.dataDir!, state, fs)
  }
}

// duck -p and --mode: one answer, JSON lines or an RPC session on stdio; resolves to the exit code
export async function runPrintMode(
  options: LaunchOptions,
  { connect, close }: { connect(): Promise<Connection>; close(): Promise<void> }
) {
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
    process.on(signal, () => void close().finally(() => Bare.exit(130)))
  }

  let code = 1
  try {
    const host = await connect()
    code = await runPrint(host.engine, {
      deviceId: host.deviceId ?? null,
      options: options,
      io: {
        stdout: process.stdout,
        stderr: process.stderr,
        stdin:
          options.mode === 'rpc' || options.stdinPiped ? (process.stdin as PrintIO['stdin']) : null,
        context: contextPreamble(loadContextFiles({ cwd: process.cwd() }))
      }
    })
  } catch (error) {
    process.stderr.write(`duck: ${error instanceof Error ? error.message : String(error)}\n`)
  }

  return code
}
