import fs from 'bare-fs'
import path from 'bare-path'

// Folders, not files: an editor that saves by renaming would end a watch on the file itself.
export function watchFiles(
  files: string[],
  onChange: () => void | Promise<void>,
  { delayMs = 300 } = {}
) {
  const byDir = new Map<string, Set<string>>()
  for (const file of files) {
    const dir = path.dirname(file)
    byDir.set(dir, (byDir.get(dir) || new Set()).add(path.basename(file)))
  }

  let timer: ReturnType<typeof setTimeout> | undefined
  // one save fires several events, and the file may be half written at the first
  const fire = () => {
    clearTimeout(timer)
    timer = setTimeout(onChange, delayMs)
  }
  const watchers = [...byDir].map(([dir, names]) =>
    fs.watch(dir, (_event, name) => names.has(String(name)) && fire())
  )

  return () => {
    clearTimeout(timer)
    for (const watcher of watchers) {
      watcher.close()
    }
  }
}

// The config file and every extension it lists by path, resolved from the config's folder.
export function extensionFiles(configPath: string, entries: unknown[] = []) {
  const base = path.dirname(configPath)
  const uses = entries
    .map((entry) =>
      typeof entry === 'string'
        ? entry
        : entry && typeof entry === 'object' && 'use' in entry
          ? entry.use
          : undefined
    )
    .filter((value): value is string => typeof value === 'string' && !!value)

  return [configPath, ...uses.map((use) => path.resolve(base, use))]
}
