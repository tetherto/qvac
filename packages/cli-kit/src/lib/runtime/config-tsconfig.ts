import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'

interface Options {
  target?: string
  useDefineForClassFields?: boolean
  baseUrl?: string
  paths?: Record<string, string[]>
  pathsBase?: string
}

// tsconfig is JSON with comments and trailing commas. Preserve string contents
// (including URLs and escaped quotes) while removing only JSONC punctuation.
function jsonc(source: string): unknown {
  let clean = '',
    quoted = false
  for (let i = 0; i < source.length; i++) {
    const char = source[i]!
    if (quoted) {
      clean += char
      if (char === '\\') clean += source[++i] ?? ''
      else if (char === '"') quoted = false
    } else if (char === '"') {
      quoted = true
      clean += char
    } else if (char === '/' && source[i + 1] === '/') {
      while (i < source.length && source[i] !== '\n') i++
      clean += '\n'
    } else if (char === '/' && source[i + 1] === '*') {
      const end = source.indexOf('*/', i + 2)
      if (end < 0) throw new SyntaxError('Unclosed tsconfig comment')
      i = end + 1
      clean += ' '
    } else {
      clean += char
    }
  }
  let json = ''
  quoted = false
  for (let i = 0; i < clean.length; i++) {
    const char = clean[i]!
    if (quoted) {
      json += char
      if (char === '\\') json += clean[++i] ?? ''
      else if (char === '"') quoted = false
    } else if (char === '"') {
      quoted = true
      json += char
    } else if (char === ',') {
      let next = i + 1
      while (/\s/.test(clean[next] ?? '') && next < clean.length) next++
      if (clean[next] !== '}' && clean[next] !== ']') json += char
    } else json += char
  }
  return JSON.parse(json.replace(/^\uFEFF/, '')) as unknown
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function read(file: string, visited = new Set<string>()): Options {
  if (visited.has(file)) throw new Error(`Circular tsconfig extends: ${file}`)
  visited.add(file)
  try {
    const value = jsonc(fs.readFileSync(file, 'utf8'))
    if (!record(value)) throw new Error(`Invalid tsconfig object: ${file}`)
    let inherited: Options = {}
    const parents = typeof value['extends'] === 'string' ? [value['extends']] : value['extends']
    if (Array.isArray(parents)) {
      for (const parent of parents) {
        if (typeof parent !== 'string') throw new Error(`Invalid tsconfig extends: ${file}`)
        let target: string
        if (parent.startsWith('.') || path.isAbsolute(parent)) {
          target = path.resolve(path.dirname(file), parent)
          if (!fs.existsSync(target)) target += '.json'
        } else {
          // These are JSON configuration files, not executable package imports.
          const require = createRequire(file)
          try {
            target = require.resolve(parent)
          } catch {
            target = require.resolve(`${parent}/tsconfig.json`)
          }
        }
        inherited = { ...inherited, ...read(target, visited) }
      }
    }
    const options = value['compilerOptions']
    if (!record(options)) return inherited
    const baseUrl =
      typeof options['baseUrl'] === 'string'
        ? path.resolve(path.dirname(file), options['baseUrl'])
        : inherited.baseUrl
    const result: Options = { ...inherited, ...(baseUrl ? { baseUrl } : {}) }
    if (typeof options['target'] === 'string') result.target = options['target'].toLowerCase()
    if (typeof options['useDefineForClassFields'] === 'boolean') {
      result.useDefineForClassFields = options['useDefineForClassFields']
    }
    if (record(options['paths'])) {
      result.paths = {}
      result.pathsBase = path.dirname(file)
      for (const [key, targets] of Object.entries(options['paths'])) {
        if (
          !Array.isArray(targets) ||
          !targets.every((target): target is string => typeof target === 'string')
        ) {
          throw new Error(`Invalid tsconfig paths for ${key}: ${file}`)
        }
        result.paths[key] = targets
      }
    }
    return result
  } finally {
    visited.delete(file)
  }
}

export function configAliases(entry: string): (specifier: string) => string[] {
  let dir = path.dirname(entry)
  let options: Options = {}
  while (true) {
    const file = path.join(dir, 'tsconfig.json')
    if (fs.existsSync(file)) {
      options = read(file)
      break
    }
    const parent = path.dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  if (
    options.useDefineForClassFields === false ||
    (options.useDefineForClassFields !== true &&
      /^(es3|es5|es6|es201[5-9]|es202[01])$/.test(options.target ?? 'esnext'))
  ) {
    throw new Error(
      `QVAC config uses native JavaScript class fields. The tsconfig for ${entry} requests assignment-style fields; use useDefineForClassFields:true or compile the config to JavaScript first.`
    )
  }
  const entries = Object.entries(options.paths ?? {}).sort(([a], [b]) => {
    const prefix = (key: string) => (key.includes('*') ? key.indexOf('*') : Infinity)
    return prefix(b) - prefix(a) || b.length - a.length
  })
  return (specifier) => {
    for (const [key, targets] of entries) {
      const star = key.indexOf('*')
      if (star < 0) {
        if (key === specifier) {
          return targets.map((target) =>
            path.resolve(options.baseUrl ?? options.pathsBase!, target)
          )
        }
        continue
      }
      const before = key.slice(0, star),
        after = key.slice(star + 1)
      if (
        specifier.startsWith(before) &&
        specifier.endsWith(after) &&
        specifier.length >= before.length + after.length
      ) {
        const middle = specifier.slice(before.length, after ? -after.length : undefined)
        return targets.map((target) =>
          path.resolve(options.baseUrl ?? options.pathsBase!, target.replace('*', middle))
        )
      }
    }
    return options.baseUrl ? [path.resolve(options.baseUrl, specifier)] : []
  }
}
