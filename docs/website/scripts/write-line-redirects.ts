#!/usr/bin/env bun
/**
 * Expand the documentation-line markers of the exported `_redirects`.
 *
 * Usage (after `next build`): bun run scripts/write-line-redirects.ts
 *
 * `next build` copies `public/_redirects` into `out/` as it is, markers
 * included. This rewrites `out/_redirects` with the rules every published and
 * retired line needs, generated from the versions files
 * (`src/lib/line-redirects.ts`). `public/_redirects` is never modified.
 */
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import { expandLineRedirects, publishedRules, retiredRules } from '../src/lib/line-redirects'

const OUT_REDIRECTS = path.join(import.meta.dirname, '..', 'out', '_redirects')

const source = await fs.readFile(OUT_REDIRECTS, 'utf-8').catch(() => {
  console.error(`No ${OUT_REDIRECTS}. Run \`next build\` first.`)
  process.exit(1)
})
await fs.writeFile(OUT_REDIRECTS, expandLineRedirects(source))
console.log(
  `Wrote ${publishedRules().length / 3} published and ${retiredRules().length / 3} retired line(s) to out/_redirects`,
)
