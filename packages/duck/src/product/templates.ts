const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/
const PLACEHOLDER = /\$\{(\d+|@)(?::-([^}]*)|:(\d+)(?::(\d+))?)?\}|\$ARGUMENTS|\$@|\$(\d)/g

export function parseTemplate(name: string, source: string) {
  const match = source.match(FRONTMATTER),
    meta: Record<string, string> = {}
  for (const line of match ? match[1]!.split(/\r?\n/) : []) {
    const pair = line.match(/^\s*([\w-]+)\s*:\s*(.*?)\s*$/)
    if (pair) {
      meta[pair[1]!] = pair[2]!.replace(/^(["'])(.*)\1$/, '$2')
    }
  }

  const body = match ? source.slice(match[0].length) : source
  const firstLine = body.split('\n').find((l: string) => l.trim()) || ''

  return {
    name,
    description: meta['description'] || firstLine.trim().slice(0, 80),
    argumentHint: meta['argument-hint'] || '',
    body
  }
}

export function splitArgs(input: string) {
  const out = []
  let current = '',
    quote: string | null = null,
    started = false
  for (let i = 0; i < input.length; i++) {
    const ch = input[i]!
    if (quote === "'") {
      if (ch === "'") {
        quote = null
      } else {
        current += ch
      }
    } else if (
      ch === '\\' &&
      i + 1 < input.length &&
      (quote === null || /["\\$`]/.test(input[i + 1]!))
    ) {
      current += input[++i]
      started = true
    } else if (quote === '"') {
      if (ch === '"') {
        quote = null
      } else {
        current += ch
      }
    } else if (ch === "'" || ch === '"') {
      quote = ch
      started = true
    } else if (/\s/.test(ch)) {
      if (started) {
        out.push(current)
      }

      current = ''
      started = false
    } else {
      current += ch
      started = true
    }
  }

  if (started) {
    out.push(current)
  }

  return out
}

export function expandTemplate(body: string, argsString = '') {
  const args = splitArgs(argsString)
  return body.replace(PLACEHOLDER, (whole: string, ...groups: (string | undefined)[]) => {
    const [key, fallback, start, length, digit] = groups
    if (digit !== undefined) {
      return args[Number(digit) - 1] ?? ''
    }

    if (whole === '$ARGUMENTS' || whole === '$@') {
      return args.join(' ')
    }

    if (key === '@') {
      if (fallback !== undefined) {
        return args.length ? args.join(' ') : fallback
      }

      const from = Math.max(0, Number(start ?? 1) - 1)

      return args.slice(from, length === undefined ? undefined : from + Number(length)).join(' ')
    }

    const value = args[Number(key) - 1]
    if (start !== undefined) {
      return whole
    }

    return value === undefined || value === '' ? (fallback ?? '') : value
  })
}
