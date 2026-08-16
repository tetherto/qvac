import { spawnSync } from 'bare-subprocess'

export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)}MB`
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)}GB`
}

export function getCommitHash(short = false): string {
  const args = short ? ['rev-parse', '--short', 'HEAD'] : ['rev-parse', 'HEAD']
  const result = spawnSync('git', args)
  if (result.status !== 0 || !result.stdout) {
    throw new Error('Git is required to generate history file')
  }
  return result.stdout.toString('utf8').trim()
}
