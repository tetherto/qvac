import { readFileSync } from 'node:fs'

function add (set: Set<string>, method: string, pathTemplate: string): void {
  set.add(`${method} ${pathTemplate}`)
}

/**
 * Extract implemented route templates from the OpenAI adapter dispatcher.
 */
export function parseRouter (routerSourcePath: string): string[] {
  const text = readFileSync(routerSourcePath, 'utf8')
  const keys = new Set<string>()

  const exactRe = /if\s*\(\s*method\s*===\s*'(GET|POST|PUT|DELETE|PATCH)'\s*&&\s*path\s*===\s*'(\/v1\/[^']+)'\s*\)/g
  for (const match of text.matchAll(exactRe)) {
    add(keys, match[1]!, match[2]!)
  }

  const startsRe = /if\s*\(\s*method\s*===\s*'(GET|POST|PUT|DELETE|PATCH)'\s*&&\s*path\.startsWith\('(\/v1\/[^']+)\/'\)\s*\)/g
  for (const match of text.matchAll(startsRe)) {
    const method = match[1]!
    const prefix = match[2]!
    if (prefix === '/v1/models') {
      add(keys, method, '/v1/models/{model}')
    }
  }

  if (text.includes('fileContentMatch') && text.includes('/files/')) {
    add(keys, 'GET', '/v1/files/{file_id}/content')
  }

  if (text.includes('fileIdMatch')) {
    add(keys, 'GET', '/v1/files/{file_id}')
  }

  if (text.includes('vectorStoreSub')) {
    add(keys, 'POST', '/v1/vector_stores/{vector_store_id}/search')
    add(keys, 'POST', '/v1/vector_stores/{vector_store_id}/files')
  }

  if (text.includes('vectorStoreIdOnly')) {
    add(keys, 'GET', '/v1/vector_stores/{vector_store_id}')
    add(keys, 'POST', '/v1/vector_stores/{vector_store_id}')
    add(keys, 'DELETE', '/v1/vector_stores/{vector_store_id}')
  }

  if (text.includes("path.startsWith('/v1/responses/')")) {
    add(keys, 'GET', '/v1/responses/{response_id}')
    add(keys, 'DELETE', '/v1/responses/{response_id}')
    add(keys, 'GET', '/v1/responses/{response_id}/input_items')
  }

  return [...keys].sort()
}
