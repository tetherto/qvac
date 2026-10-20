import {
  validateCodeRanges,
  validatePackageCodes,
  type CodeRangeRegistry
} from '../../packages/error/src/code-ranges.js'
import { readCodeMap, referencedCodeMaps } from './read.js'

export interface CodeSource {
  owner: string
  file: string
  symbols: string[]
}

export function checkCodeSources(
  registry: CodeRangeRegistry,
  sources: readonly CodeSource[],
  files: ReadonlyMap<string, string>
): void {
  validateCodeRanges(registry)
  const covered = new Set(sources.map(({ file }) => file))
  const generated = new Set(
    sources
      .filter(({ file }) => file.endsWith('.ts'))
      .map(({ file }) => file.replace('/src/', '/').replace(/\.ts$/, '.js'))
  )
  const numbers = new Map<number, { name: string; file: string }>()
  const names = new Map<string, { owner: string; code: number }[]>()
  for (const { owner, file, symbols } of sources) {
    const source = files.get(file)
    if (source === undefined) throw new Error(`Missing error source: ${file}`)
    if (!symbols.length) throw new Error(`No code tables listed for ${file}`)
    for (const symbol of referencedCodeMaps(source)) {
      if (!symbols.includes(symbol)) throw new Error(`Unlisted code table: ${file}:${symbol}`)
    }
    for (const symbol of symbols) {
      const codes = readCodeMap(source, symbol)
      validatePackageCodes(registry, owner, codes)
      for (const [name, code] of Object.entries(codes)) {
        const allocation = registry.allocations.find(({ ranges }) =>
          ranges.some(([start, end]) => code >= start && code <= end)
        )
        const existing = numbers.get(code)
        const aliases = allocation?.aliases?.[code]
        if (
          existing &&
          existing.name !== name &&
          !(aliases?.includes(name) && aliases.includes(existing.name))
        ) {
          throw new Error(
            `${code}: conflicting names ${existing.name} (${existing.file}) and ${name} (${file})`
          )
        }
        numbers.set(code, { name, file })
        const block = allocation?.ranges.find(([start, end]) => code >= start && code <= end)
        const key = `${allocation?.owner}:${block?.[0]}:${name}`
        const previous = names.get(key) ?? []
        if (previous.some((entry) => entry.owner !== owner && entry.code !== code)) {
          throw new Error(`${name}: conflicting numbers in shared family (${file})`)
        }
        previous.push({ owner, code })
        names.set(key, previous)
      }
    }
  }
  for (const [file, source] of files) {
    if (
      source.includes('@qvac/error') &&
      /\baddCodes\b/.test(source) &&
      !covered.has(file) &&
      !generated.has(file)
    ) {
      throw new Error(
        `Unlisted error registration module: ${file}; add its code tables to code-ranges.json sources`
      )
    }
  }
}
