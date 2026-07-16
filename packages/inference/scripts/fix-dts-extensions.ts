/// <reference types="bare" />
// Rewrites `.ts`/`.tsx` relative specifiers to `.js` in the emitted `.d.ts`.
// `rewriteRelativeImportExtensions` handles this for the JS output but not the
// declarations (TS 5.9), so without this pass every declaration specifier ends
// in `.ts` and fails to resolve unless the consumer sets `allowImportingTsExtensions`.

import fs from 'bare-fs'
import path from 'bare-path'

const buildDir = Bare.argv[2]
if (!buildDir) {
  console.error('usage: bare scripts/fix-dts-extensions.ts <build-dir>')
  Bare.exit(1)
}
const DIST = path.resolve(buildDir)

const RELATIVE_TS = /((?:from|import)\s*\(?\s*['"])(\.\.?\/[^'"]*?)\.tsx?(['"])/g

function walk(dir: string, out: string[] = []) {
  for (const name of fs.readdirSync(dir)) {
    const full = path.join(dir, name)
    if (fs.statSync(full).isDirectory()) walk(full, out)
    else if (name.endsWith('.d.ts')) out.push(full)
  }
  return out
}

let files = 0
let edits = 0
for (const file of walk(DIST)) {
  const source = fs.readFileSync(file, 'utf8')
  let fileEdits = 0
  const rewritten = source.replace(RELATIVE_TS, (_match, pre, spec, post) => {
    fileEdits++
    return `${pre}${spec}.js${post}`
  })
  if (fileEdits > 0) {
    fs.writeFileSync(file, rewritten)
    files++
    edits += fileEdits
  }
}

console.log(`fix-dts-extensions: ${edits} specifiers in ${files} files`)
