import { execFile } from 'node:child_process'
import path from 'node:path'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

const GIT_EXEC_ENV: NodeJS.ProcessEnv = {
  ...process.env,
  LANG: 'C',
  LC_ALL: 'C'
}

export interface LockfilePackage {
  lockPath: string
  name: string
  version?: string
}

export interface ReadLockfileAtRefOptions {
  projectRoot: string
  ref: string
  lockfilePath: string
}

export class LockfileReadError extends Error {
  constructor (
    message: string,
    cause?: unknown
  ) {
    super(message, cause === undefined ? undefined : { cause })
    this.name = 'LockfileReadError'
  }
}

export class LockfileNotFoundAtRefError extends LockfileReadError {
  constructor (
    readonly ref: string,
    readonly lockfilePath: string,
    cause?: unknown
  ) {
    super(`Lockfile not found at ${ref}:${lockfilePath}`, cause)
    this.name = 'LockfileNotFoundAtRefError'
  }
}

function toText (value: string | Buffer): string {
  return typeof value === 'string' ? value : value.toString('utf8')
}

function errorOutput (error: unknown): string {
  if (typeof error === 'object' && error !== null) {
    const maybe = error as { message?: unknown, stderr?: unknown }
    const stderr = typeof maybe.stderr === 'string'
      ? maybe.stderr
      : Buffer.isBuffer(maybe.stderr)
        ? maybe.stderr.toString('utf8')
        : ''
    const message = typeof maybe.message === 'string' ? maybe.message : ''
    return `${message}\n${stderr}`
  }
  return String(error)
}

function isMissingGitPathError (error: unknown): boolean {
  return /does not exist|exists on disk, but not in/i.test(errorOutput(error))
}

async function runGit (cwd: string, args: string[]): Promise<string> {
  try {
    const { stdout } = await execFileAsync('git', args, {
      cwd,
      env: GIT_EXEC_ENV,
      maxBuffer: 32 * 1024 * 1024
    })
    return toText(stdout).trim()
  } catch (error) {
    throw new LockfileReadError(`git ${args.join(' ')} failed`, error)
  }
}

function toGitPath (filePath: string, gitRoot: string): string {
  return path.relative(gitRoot, filePath).split(path.sep).join('/')
}

export async function findGitRoot (cwd: string): Promise<string> {
  return runGit(cwd, ['rev-parse', '--show-toplevel'])
}

export async function resolveGitRef (cwd: string, ref: string): Promise<string> {
  return runGit(cwd, ['rev-parse', '--verify', `${ref}^{commit}`])
}

export async function readLockfileTextAtRef (
  options: ReadLockfileAtRefOptions
): Promise<string> {
  const absLockfilePath = path.isAbsolute(options.lockfilePath)
    ? options.lockfilePath
    : path.join(options.projectRoot, options.lockfilePath)
  const gitRoot = await findGitRoot(options.projectRoot)
  const lockfileGitPath = toGitPath(absLockfilePath, gitRoot)
  const sha = await resolveGitRef(options.projectRoot, options.ref)
  const showArg = `${sha}:${lockfileGitPath}`
  try {
    const { stdout } = await execFileAsync('git', ['show', showArg], {
      cwd: options.projectRoot,
      env: GIT_EXEC_ENV,
      maxBuffer: 32 * 1024 * 1024
    })
    return toText(stdout).trim()
  } catch (error) {
    if (isMissingGitPathError(error)) {
      throw new LockfileNotFoundAtRefError(
        options.ref,
        lockfileGitPath,
        error
      )
    }
    throw new LockfileReadError(`git show ${showArg} failed`, error)
  }
}
