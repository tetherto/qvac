import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

export interface GitPathHistory {
  readonly path: string
  readonly commitCount: number
  readonly lastChanged?: string
}

export interface GitHistoryOptions {
  readonly root: string
  readonly paths: readonly string[]
  readonly now: Date
  readonly windowDays: number
}

interface CommitEntry {
  readonly date: string
  readonly changes: readonly PathChange[]
}

type PathChange =
  | { readonly kind: 'path'; readonly path: string }
  | { readonly kind: 'rename'; readonly before: string; readonly after: string }

export async function collectGitHistory(
  options: GitHistoryOptions,
): Promise<readonly GitPathHistory[]> {
  const paths = [...new Set(options.paths)].sort(compareStrings)
  if (paths.length === 0) {
    return []
  }
  if (!await hasHead(options.root)) {
    return paths.map((path) => ({ path, commitCount: 0 }))
  }

  const since = new Date(
    options.now.getTime() - options.windowDays * 24 * 60 * 60 * 1000,
  ).toISOString().slice(0, 10)
  const { stdout } = await execFileAsync(
    'git',
    [
      'log',
      `--since=${since}`,
      '--date=iso-strict',
      '--format=%x1e%H%x09%cI',
      '--name-status',
      '--find-renames',
    ],
    {
      cwd: options.root,
      encoding: 'utf8',
      maxBuffer: 100 * 1024 * 1024,
    },
  )
  const commits = parseGitLog(stdout)
  const aliases = new Map(paths.map((path) => [path, new Set([path])]))
  const countByPath = new Map(paths.map((path) => [path, 0]))
  const latestByPath = new Map<string, string>()

  for (const commit of commits) {
    for (const path of paths) {
      const knownPaths = aliases.get(path)
      if (knownPaths === undefined) {
        continue
      }
      let touched = false
      for (const change of commit.changes) {
        if (change.kind === 'path') {
          touched ||= knownPaths.has(change.path)
          continue
        }
        if (knownPaths.has(change.after)) {
          knownPaths.add(change.before)
          touched = true
        } else if (knownPaths.has(change.before)) {
          touched = true
        }
      }
      if (!touched) {
        continue
      }
      countByPath.set(path, (countByPath.get(path) ?? 0) + 1)
      if (!latestByPath.has(path)) {
        latestByPath.set(path, commit.date.slice(0, 10))
      }
    }
  }

  return paths.map((path) => {
    const lastChanged = latestByPath.get(path)
    const shared = { path, commitCount: countByPath.get(path) ?? 0 }
    return lastChanged === undefined
      ? shared
      : { ...shared, lastChanged }
  })
}

async function hasHead(root: string): Promise<boolean> {
  try {
    await execFileAsync('git', ['rev-parse', '--verify', 'HEAD'], { cwd: root })
    return true
  } catch {
    return false
  }
}

function parseGitLog(source: string): readonly CommitEntry[] {
  return source
    .split('\u001e')
    .map((chunk) => chunk.trim())
    .filter((chunk) => chunk !== '')
    .map((chunk) => {
      const [header = '', ...lines] = chunk.split(/\r?\n/)
      const [, date = ''] = header.split('\t')
      return {
        date,
        changes: lines.flatMap(parsePathChange),
      }
    })
}

function parsePathChange(line: string): readonly PathChange[] {
  const fields = line.split('\t')
  const status = fields[0] ?? ''
  if (status.startsWith('R') && fields[1] !== undefined && fields[2] !== undefined) {
    return [{ kind: 'rename', before: fields[1], after: fields[2] }]
  }
  return fields[1] === undefined
    ? []
    : [{ kind: 'path', path: fields[1] }]
}

function compareStrings(left: string, right: string): number {
  return left.localeCompare(right, 'en')
}
