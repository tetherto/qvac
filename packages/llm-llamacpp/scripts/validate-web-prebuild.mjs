import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import npmCommand from './npm-command.cjs'

const variants = ['llm-llamacpp', 'llm-llamacpp-64']

function loaderWasmReferences(loader) {
  const references = new Set()
  const patterns = [
    /locateFile\(\s*["']([^"']+\.wasm)["']\s*\)/g,
    /new URL\(\s*["']([^"']+\.wasm)["']\s*,\s*import\.meta\.url\s*\)/g
  ]
  for (const pattern of patterns) {
    for (const match of loader.matchAll(pattern)) references.add(match[1])
  }
  return references
}

export function validateEngineFiles(output) {
  for (const variant of variants) {
    const loaderPath = join(output, `${variant}.mjs`)
    const wasmPath = join(output, `${variant}.wasm`)
    if (!existsSync(loaderPath)) throw new Error(`Missing browser engine loader: ${loaderPath}`)
    if (!existsSync(wasmPath)) throw new Error(`Missing browser engine binary: ${wasmPath}`)

    const loader = readFileSync(loaderPath, 'utf8')
    const wasmName = `${variant}.wasm`
    const references = loaderWasmReferences(loader)
    if (references.size !== 1 || !references.has(wasmName)) {
      throw new Error(`${loaderPath} does not resolve its matching ${wasmName}`)
    }
  }
}

export function validatePackFiles(packResult) {
  const entries = JSON.parse(packResult)
  if (!Array.isArray(entries) || entries.length !== 1 || !Array.isArray(entries[0].files)) {
    throw new Error('npm pack did not report exactly one package')
  }
  const files = new Set(entries[0].files.map(({ path }) => path))
  for (const variant of variants) {
    for (const extension of ['mjs', 'wasm']) {
      const path = `prebuilds/web/${variant}.${extension}`
      if (!files.has(path)) throw new Error(`Packed package is missing ${path}`)
    }
  }
}

export function validateWebPrebuild(root, output) {
  validateEngineFiles(output)
  const { command, prefix } = npmCommand()
  const packResult = execFileSync(
    command,
    [...prefix, 'pack', '--dry-run', '--json', '--ignore-scripts'],
    { cwd: root, encoding: 'utf8' }
  )
  validatePackFiles(packResult)
}

const script = fileURLToPath(import.meta.url)
if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const root = resolve(dirname(script), '..')
  validateWebPrebuild(root, join(root, 'prebuilds', 'web'))
}
