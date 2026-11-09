#!/usr/bin/env bun
/**
 * Check the docs contract over each documented software's development line.
 *
 * Usage: bun run scripts/contract/check-contract.ts [<software>…]   # docs:contract
 *
 * For each software declared under `versions/` (or each one named, by its URL
 * slug), reads its documentation root from the working tree and checks it
 * against its kind's definition, `contract/kinds.json`:
 *
 * - every required page exists, as `<page>.mdx` or a `<page>/` folder;
 * - a page the definition marks generated carries the generator's marker;
 * - a `platform` package's overview links a product, the canonical way to use
 *   its capability.
 *
 * Exits 1 naming the software and each missing piece. Runs on pull requests,
 * never in the build, so a new rule never fails the build of a line pinned
 * before it.
 */
import { existsSync, readFileSync, statSync } from 'node:fs'
import * as path from 'node:path'
import { declaredSoftware } from '../../src/lib/versions'
import type { VersionsFile } from '../../src/lib/versions-file'
import { isGeneratedPage } from '../bindings/bindings'

const WEBSITE = path.resolve(import.meta.dirname, '..', '..')
const MONOREPO = path.resolve(WEBSITE, '..', '..')

export interface RequiredPage {
  id: string
  page: string
  generated?: boolean
  states: string
}

export type KindDefinitions = Record<VersionsFile['kind'], { requiredPages: RequiredPage[] }>

export function readKinds(file = path.join(WEBSITE, 'contract', 'kinds.json')): KindDefinitions {
  return JSON.parse(readFileSync(file, 'utf-8')) as KindDefinitions
}

/** The file that holds a page: `<page>.mdx`, or a folder's `index.mdx`; null when absent. */
function pageFile(docsRoot: string, page: string): { file: string | null; exists: boolean } {
  for (const candidate of [`${page}.mdx`, `${page}.md`]) {
    const file = path.join(docsRoot, candidate)
    if (existsSync(file)) return { file, exists: true }
  }
  const folder = path.join(docsRoot, page)
  if (existsSync(folder) && statSync(folder).isDirectory()) {
    const index = path.join(folder, 'index.mdx')
    return { file: existsSync(index) ? index : null, exists: true }
  }
  return { file: null, exists: false }
}

/** Everything a software's documentation root lacks under its kind's definition. */
export function checkContract(
  declaration: VersionsFile,
  docsRoot: string,
  kinds: KindDefinitions,
  productPaths: readonly string[],
): string[] {
  const problems: string[] = []
  const label = `${declaration.package} (${declaration.kind})`
  if (!existsSync(docsRoot)) return [`${label}: no documentation root at ${path.relative(MONOREPO, docsRoot)}`]

  for (const required of kinds[declaration.kind].requiredPages) {
    const { file, exists } = pageFile(docsRoot, required.page)
    if (!exists) {
      problems.push(`${label}: missing the ${required.id} page, \`${required.page}.mdx\` — ${required.states}`)
      continue
    }
    if (required.generated && (!file || !isGeneratedPage(readFileSync(file, 'utf-8')))) {
      problems.push(`${label}: \`${required.page}\` is not the generated page — ${required.states}`)
    }
  }

  if (declaration.kind === 'platform') {
    const { file } = pageFile(docsRoot, 'index')
    const text = file ? readFileSync(file, 'utf-8') : ''
    const linksProduct = productPaths.some((product) => new RegExp(`\\]\\(${product}(/[^)]*)?\\)`).test(text))
    if (file && !linksProduct) {
      problems.push(`${label}: the overview links no product; name and link the product that is the canonical way to use this capability`)
    }
  }
  return problems
}

export function run(args: string[], root = MONOREPO): number {
  const declared = declaredSoftware().map((entry) => entry.declaration)
  const unknown = args.filter((slug) => !declared.some((declaration) => declaration.path === `/${slug}`))
  if (unknown.length > 0) {
    console.error(`No versions file declares ${unknown.map((slug) => `/${slug}`).join(', ')}.`)
    return 1
  }
  const kinds = readKinds()
  const products = declared.filter((declaration) => declaration.kind === 'product').map((declaration) => declaration.path)
  let failed = false
  for (const declaration of declared) {
    if (args.length > 0 && !args.includes(declaration.path.slice(1))) continue
    const problems = checkContract(declaration, path.join(root, declaration.paths[0]), kinds, products)
    if (problems.length === 0) {
      console.log(`✓ ${declaration.package} (${declaration.kind}): the documentation meets its kind's contract.`)
      continue
    }
    failed = true
    for (const problem of problems) console.error(`✗ ${problem}`)
  }
  return failed ? 1 : 0
}

if (import.meta.main) process.exit(run(process.argv.slice(2)))
