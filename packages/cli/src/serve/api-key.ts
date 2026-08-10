import { lstatSync, readFileSync } from 'node:fs'

import { ServeOptionsError } from './startup.js'

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

function readKeyFile(path: string): string {
  let stat: ReturnType<typeof lstatSync>
  try {
    stat = lstatSync(path)
  } catch (error: unknown) {
    throw new ServeOptionsError(
      '--api-key-file',
      `cannot read the API key file at "${path}": ${error instanceof Error ? error.message : String(error)}`
    )
  }
  // `lstat`, so a symlink is refused rather than followed to a file whose
  // permissions we never checked.
  if (!stat.isFile()) {
    throw new ServeOptionsError(
      '--api-key-file',
      `the API key path "${path}" must be a regular file (symlinks and directories are refused)`
    )
  }

  const key = readFileSync(path, 'utf8').trim()
  if (key.length === 0) {
    throw new ServeOptionsError('--api-key-file', `the API key file at "${path}" is empty`)
  }
  return key
}

function loosePermissionWarning(path: string): string | undefined {
  // Windows does not model these bits; checking them there is noise.
  if (process.platform === 'win32') return undefined
  const mode = lstatSync(path).mode & 0o777
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

  return {
    apiKey: readKeyFile(options.apiKeyFile),
    warning: loosePermissionWarning(options.apiKeyFile)
  }
}
