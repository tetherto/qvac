import { getServerLogger } from '@/logging'

const warned = new Set<string>()

export function deprecate(key: string, message: string): void {
  if (warned.has(key)) return
  warned.add(key)
  // enableConsole so the notice shows even in a worker with no log-stream subscriber.
  getServerLogger({ enableConsole: true }).warn(`DEPRECATED: ${message}`)
}
