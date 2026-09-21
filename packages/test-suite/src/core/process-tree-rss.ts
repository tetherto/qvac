/**
 * Shared process-table parse + tree-sum for in-app RSS collection.
 *
 * Both the POSIX `ps` collector and the Windows CIM collector emit the same
 * whitespace-separated snapshot: `pid ppid rssKb` (one process per line).
 * RSS is already in kibibytes; Windows WorkingSetSize (bytes) must be
 * converted before it reaches this parser.
 */

export interface ProcessRssEntry {
  ppid: number
  rss: number
}

export interface ProcessRssTable {
  byPid: Map<number, ProcessRssEntry>
  childrenOf: Map<number, number[]>
}

export function parseProcessRssTable(raw: string): ProcessRssTable {
  const byPid = new Map<number, ProcessRssEntry>()
  const childrenOf = new Map<number, number[]>()

  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed || trimmed === '---') continue
    const parts = trimmed.split(/\s+/)
    if (parts.length < 3) continue
    const pid = Number(parts[0])
    const ppid = Number(parts[1])
    const rss = Number(parts[2])
    if (!Number.isFinite(pid) || !Number.isFinite(ppid) || !Number.isFinite(rss)) continue
    byPid.set(pid, { ppid, rss })
    const list = childrenOf.get(ppid)
    if (list) list.push(pid)
    else childrenOf.set(ppid, [pid])
  }

  return { byPid, childrenOf }
}

/**
 * Sum rss-kb for rootPid and every descendant. Returns null when the root
 * is missing from the snapshot or the summed tree is empty.
 */
export function sumProcessTreeRssKb(
  table: ProcessRssTable,
  rootPid: number,
  excludedPids: ReadonlySet<number> = new Set()
): number | null {
  if (!table.byPid.has(rootPid)) return null

  const seen = new Set<number>()
  const queue: number[] = [rootPid]
  let index = 0
  let total = 0
  while (index < queue.length) {
    const cur = queue[index++]
    if (seen.has(cur) || excludedPids.has(cur)) continue
    seen.add(cur)
    const entry = table.byPid.get(cur)
    if (entry) total += entry.rss
    const kids = table.childrenOf.get(cur)
    if (kids) {
      for (const k of kids) {
        if (!seen.has(k)) queue.push(k)
      }
    }
  }

  return total > 0 ? total : null
}
