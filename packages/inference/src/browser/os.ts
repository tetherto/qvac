// bare-os stand-in for the browser build.

import { browser } from './globals'

const GiB = 1024 * 1024 * 1024

export function platform(): string {
  return 'browser'
}

export function arch(): string {
  return 'wasm32'
}

export function cwd(): string {
  return '/'
}

export function homedir(): string {
  return '/'
}

export function tmpdir(): string {
  return '/tmp'
}

export function pid(): number {
  return 1
}

export function kill(): never {
  throw new Error('Processes cannot be signalled in the browser')
}

// navigator.deviceMemory is a coarse, capped hint (at most 8 GiB).
export function availableMemory(): number {
  return (browser.navigator.deviceMemory ?? 4) * GiB
}

export function totalmem(): number {
  return availableMemory()
}

export function memoryUsage(): {
  rss: number
  heapTotal: number
  heapUsed: number
  external: number
} {
  return { rss: 0, heapTotal: 0, heapUsed: 0, external: 0 }
}

export default {
  platform,
  arch,
  cwd,
  homedir,
  tmpdir,
  pid,
  kill,
  availableMemory,
  totalmem,
  memoryUsage
}
