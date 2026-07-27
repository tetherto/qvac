type HeaderSource = Readonly<Record<string, string | undefined>> | undefined

/** Merge header records case-insensitively, with later sources taking precedence. */
export function mergeHeaders(...sources: HeaderSource[]): Record<string, string> {
  const merged = new Headers()
  for (const source of sources) {
    if (source === undefined) continue
    for (const [name, value] of Object.entries(source)) {
      if (value !== undefined) merged.set(name, value)
    }
  }
  return Object.fromEntries(merged.entries())
}
