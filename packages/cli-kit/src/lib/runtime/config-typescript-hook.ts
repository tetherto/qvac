import fs from 'node:fs'
import path from 'node:path'
import { stripTypeScriptTypes, type LoadHook, type ResolveHook } from 'node:module'
import { fileURLToPath, pathToFileURL } from 'node:url'
// Loader hooks run where only Node's own type stripping applies, so the sibling takes this file's extension
const { configAliases }: typeof import('./config-tsconfig.js') = await import(
  `./config-tsconfig${import.meta.url.slice(-3)}`
)

interface Graph {
  id: string
  aliases: ReturnType<typeof configAliases>
}
const tagged = new Map<string, Graph>()
let sequence = 0

function local(url: string): boolean {
  return url.startsWith('file:') && !fileURLToPath(url).split(path.sep).includes('node_modules')
}
function tag(url: string, graph: Graph): string {
  if (!local(url)) {
    if (url.startsWith('file:') && /\.[cm]?tsx?$/.test(fileURLToPath(url))) tagged.set(url, graph)
    return url
  }
  const result = new URL(url)
  result.searchParams.set('qvac-config', graph.id)
  tagged.set(result.href, graph)
  return result.href
}
function file(url: URL, seen = new Set<string>()): string | undefined {
  const original = fileURLToPath(url)
  if (seen.has(original)) return undefined
  seen.add(original)
  const ext = path.extname(original)
  const swapped: Record<string, string[]> = {
    '.js': ['.ts', '.tsx', '.js', '.jsx'],
    '.mjs': ['.mts', '.mjs'],
    '.cjs': ['.cts', '.cjs'],
    '.jsx': ['.tsx', '.jsx']
  }
  const candidates =
    swapped[ext]?.map((suffix) => original.slice(0, -ext.length) + suffix) ??
    (ext
      ? [original]
      : [
          original,
          ...['.ts', '.tsx', '.js', '.jsx', '.json', '.mjs', '.cjs'].map(
            (suffix) => original + suffix
          )
        ])
  for (const candidate of candidates) {
    try {
      if (!fs.statSync(candidate).isFile()) continue
      const found = pathToFileURL(fs.realpathSync(candidate))
      found.search = url.search
      found.hash = url.hash
      return found.href
    } catch (error) {
      if (!['ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error
    }
  }
  try {
    if (!fs.statSync(original).isDirectory()) return undefined
    const manifest = path.join(original, 'package.json')
    if (fs.existsSync(manifest)) {
      const value: unknown = JSON.parse(fs.readFileSync(manifest, 'utf8'))
      if (value && typeof value === 'object' && 'main' in value && typeof value.main === 'string') {
        const main = file(pathToFileURL(path.resolve(original, value.main)), seen)
        if (main) return main
      }
    }
    return file(pathToFileURL(path.join(original, 'index')), seen)
  } catch (error) {
    if (!['ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error
  }

  return undefined
}

export const resolve: ResolveHook = async (specifier, context, next) => {
  if (specifier.startsWith('qvac-config:')) {
    const url = decodeURIComponent(specifier.slice(12))
    const graph: Graph = { id: String(++sequence), aliases: configAliases(fileURLToPath(url)) }
    const resolved = await next(url, context)
    return { ...resolved, url: tag(resolved.url, graph) }
  }
  const graph = context.parentURL ? tagged.get(context.parentURL) : undefined
  if (!graph) return next(specifier, context)
  const relative =
    specifier.startsWith('.') || specifier.startsWith('/') || specifier.startsWith('file:')
  if (relative) {
    const url = new URL(specifier, context.parentURL)
    if (url.protocol === 'file:') {
      const found = file(url)
      if (found) return { url: tag(found, graph), shortCircuit: true }
    }
  } else if (
    local(context.parentURL!) &&
    !specifier.startsWith('#') &&
    !/^[a-z][a-z\d+.-]*:/i.test(specifier)
  ) {
    for (const candidate of graph.aliases(specifier)) {
      const found = file(pathToFileURL(candidate))
      if (found) return { url: tag(found, graph), shortCircuit: true }
    }
  }
  const result = await next(specifier, context)
  // Bare package specifiers retain their native identity, including workspace
  // symlinks whose real paths are outside node_modules.
  if (!relative && !specifier.startsWith('#')) {
    if (result.url.startsWith('file:') && /\.[cm]?tsx?$/.test(fileURLToPath(result.url))) {
      tagged.set(result.url, graph)
    }
    return result
  }
  return { ...result, url: tag(result.url, graph) }
}

export const load: LoadHook = async (url, context, next) => {
  if (!tagged.has(url)) return next(url, context)
  const ext = path.extname(fileURLToPath(url))
  if (ext === '.tsx' || ext === '.jsx') {
    throw new Error(
      `QVAC config uses native Node TypeScript; JSX is unsupported. Compile ${fileURLToPath(url)} to JavaScript first.`
    )
  }
  if (ext === '.json') {
    const value: unknown = JSON.parse(fs.readFileSync(fileURLToPath(url), 'utf8'))
    return {
      format: 'module',
      source: `export default JSON.parse(${JSON.stringify(JSON.stringify(value))})`,
      shortCircuit: true
    }
  }
  if (!['.ts', '.mts', '.cts'].includes(ext)) return next(url, context)
  const source = fs.readFileSync(fileURLToPath(url), 'utf8')
  let transformed: string
  try {
    transformed = stripTypeScriptTypes(source, {
      mode: 'transform',
      sourceUrl: url,
      sourceMap: true
    })
  } catch (cause) {
    throw new Error(
      `Cannot transform QVAC TypeScript config ${fileURLToPath(url)}. Use Node-supported TypeScript or compile it to JavaScript first.`,
      { cause }
    )
  }
  return { format: ext === '.cts' ? 'commonjs' : 'module', source: transformed, shortCircuit: true }
}
