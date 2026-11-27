import { readdirSync } from 'node:fs'
import { resolve, join } from 'node:path'
import { execFileSync } from 'node:child_process'

const host = 'android-arm64'
const module = `qvac__fabric-${host}`
const root = resolve(process.argv[2] || `prebuilds/${host}`)
const directory = join(root, module)
const backends = readdirSync(directory).filter((name) => /^libqvac-ggml-.*\.so$/.test(name))
for (const core of ['base', 'vector-index', '']) {
  const name = `libqvac-ggml${core ? '-' + core : ''}-1.so`
  if (!backends.includes(name)) throw new Error(`Missing Android shared core: ${name}`)
}
for (const [file, expected] of [
  [join(root, module + '.bare'), '$ORIGIN/' + module],
  ...backends.map((name) => [join(directory, name), '$ORIGIN'])
]) {
  const dynamic = execFileSync(process.env.READELF || 'llvm-readelf', ['-d', file], {
    encoding: 'utf8'
  })
  const runpath = /\(RUNPATH\).*\[([^\]]+)\]/.exec(dynamic)?.[1]?.split(':') || []
  if (!runpath.includes(expected)) throw new Error(`${file}: missing RUNPATH ${expected}`)
}
console.log(`Verified Android sibling lookup for Fabric and ${backends.length} ggml libraries`)
