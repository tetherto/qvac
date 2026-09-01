import { closeSync, constants, fstatSync, openSync, readFileSync } from 'node:fs'

import { ServeOptionsError } from '@/serve/startup'

export interface ServeApiKeyOptions {
  readonly apiKey?: string | undefined
  readonly apiKeyFile?: string | undefined
}

export interface ResolvedServeApiKey {
  readonly apiKey: string | undefined
  readonly warning: string | undefined
}

// Owner-only. Group or world bits on a bearer credential mean any local account
// can read it, which is the whole reason the file form exists.
const PRIVATE_FILE_MODE = 0o600

// POSIX-only; Windows resolves symlinks below the API and has no equivalent flag.
const NO_FOLLOW = constants.O_NOFOLLOW ?? 0

interface KeyFile {
  readonly key: string
  readonly mode: number
}

// Everything is inspected through one descriptor. Checking the path with `lstat`
// and then reading it by name leaves a window in which the path can be swapped
// for a symlink, so the bytes read would come from a file whose type and
// permissions were never the ones checked.
function readKeyFile(path: string): KeyFile {
  let fd: number
  try {
    fd = openSync(path, constants.O_RDONLY | NO_FOLLOW)
  } catch (error: unknown) {
    const code = error instanceof Error && 'code' in error ? error.code : undefined
    if (code === 'ELOOP') {
      throw new ServeOptionsError(
        '--api-key-file',
        `the API key path "${path}" must be a regular file, not a symlink`
      )
    }
    throw new ServeOptionsError(
      '--api-key-file',
      `cannot read the API key file at "${path}": ${error instanceof Error ? error.message : String(error)}`
    )
  }

  try {
    const stat = fstatSync(fd)
    if (!stat.isFile()) {
      throw new ServeOptionsError(
        '--api-key-file',
        `the API key path "${path}" must be a regular file (symlinks and directories are refused)`
      )
    }
    const key = readFileSync(fd, 'utf8').trim()
    if (key.length === 0) {
      throw new ServeOptionsError('--api-key-file', `the API key file at "${path}" is empty`)
    }
    return { key, mode: stat.mode & 0o777 }
  } finally {
    closeSync(fd)
  }
}

function loosePermissionWarning(path: string, mode: number): string | undefined {
  // Windows does not model these bits; checking them there is noise.
  if (process.platform === 'win32') return undefined
  if ((mode & 0o077) === 0) return undefined
  return `Security warning: the API key file at "${path}" is readable beyond its owner (mode ${mode.toString(8).padStart(3, '0')}). Run \`chmod ${PRIVATE_FILE_MODE.toString(8)} ${path}\`.`
}

// `--api-key` puts the credential in argv, which /proc exposes to every local
// account on Linux. The file form is the way to keep it out of the process list.
export function resolveServeApiKey(options: ServeApiKeyOptions): ResolvedServeApiKey {
  if (options.apiKeyFile === undefined) {
    return { apiKey: options.apiKey, warning: undefined }
  }
  if (options.apiKey !== undefined) {
    throw new ServeOptionsError(
      '--api-key-file',
      '--api-key and --api-key-file are mutually exclusive; pass only one'
    )
  }

  const file = readKeyFile(options.apiKeyFile)
  return {
    apiKey: file.key,
    warning: loosePermissionWarning(options.apiKeyFile, file.mode)
  }
}
