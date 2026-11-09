import fs from 'bare-fs'
import path from 'bare-path'

const SKIP = new Set([
  '.git',
  'node_modules',
  'dist',
  'build',
  '.next',
  '.cache',
  'coverage',
  'target',
  '__pycache__',
  '.venv',
  'venv'
])

// Project files relative to root, breadth-first so a huge tree still yields its top levels.
export function listFiles(root: string, { limit = 20000 } = {}): string[] {
  const out: string[] = [],
    queue = ['']
  while (queue.length && out.length < limit) {
    const dir = queue.shift()!
    let entries
    try {
      entries = fs.readdirSync(path.join(root, dir), { withFileTypes: true }) as fs.Dirent<string>[]
    } catch {
      continue // unreadable directories are simply not offered
    }

    for (const entry of entries) {
      if (SKIP.has(entry.name) || (entry.name.startsWith('.') && entry.name !== '.github')) {
        continue
      }

      const rel = dir ? `${dir}/${entry.name}` : entry.name
      if (entry.isDirectory()) {
        queue.push(rel)
      } else if (entry.isFile()) {
        out.push(rel)
      }
    }
  }

  return out
}
