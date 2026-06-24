import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'

// Maps each route path's `:id` to the OpenAI spec's documented param name so
// implemented routes compare 1:1 with `parse-spec.ts` keys.
const PARAM_NAME_BY_PATH_PREFIX: Array<{ test: RegExp; name: string }> = [
  { test: /\/v1\/models\/:id$/, name: 'model' },
  { test: /\/v1\/files\/:id\/content$/, name: 'file_id' },
  { test: /\/v1\/files\/:id$/, name: 'file_id' },
  { test: /\/v1\/responses\/:id\/input_items$/, name: 'response_id' },
  { test: /\/v1\/responses\/:id$/, name: 'response_id' },
  { test: /\/v1\/vector_stores\/:id\/search$/, name: 'vector_store_id' },
  { test: /\/v1\/vector_stores\/:id\/files$/, name: 'vector_store_id' },
  { test: /\/v1\/vector_stores\/:id$/, name: 'vector_store_id' },
  { test: /\/v1\/videos\/:id\/content$/, name: 'video_id' },
  { test: /\/v1\/videos\/:id$/, name: 'video_id' }
]

function normalizeParams (path: string): string {
  for (const rule of PARAM_NAME_BY_PATH_PREFIX) {
    if (rule.test.test(path)) {
      return path.replace(/:[A-Za-z_][A-Za-z0-9_]*/g, `{${rule.name}}`)
    }
  }
  return path.replace(/:([A-Za-z_][A-Za-z0-9_]*)/g, '{$1}')
}

const ROUTE_CALL_RE = /\bapp\s*\.\s*(get|post|put|delete|patch)\s*\(\s*['"](\/v1\/[^'"]+)['"]/gi

function extractFromText (text: string, keys: Set<string>): void {
  for (const match of text.matchAll(ROUTE_CALL_RE)) {
    const method = match[1]!.toUpperCase()
    const rawPath = match[2]!
    keys.add(`${method} ${normalizeParams(rawPath)}`)
  }
}

function walk (dir: string, out: string[]): void {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    const stat = statSync(full)
    if (stat.isDirectory()) {
      walk(full, out)
    } else if (entry.endsWith('.ts') || entry.endsWith('.js')) {
      out.push(full)
    }
  }
}

export function parseRouter (routerSourceOrDir: string): string[] {
  const keys = new Set<string>()
  const abs = resolve(routerSourceOrDir)
  const stat = statSync(abs)

  const files: string[] = []
  if (stat.isDirectory()) {
    walk(abs, files)
  } else {
    files.push(abs)
  }

  for (const file of files) {
    extractFromText(readFileSync(file, 'utf8'), keys)
  }

  return [...keys].sort()
}
