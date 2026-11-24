import { readFile } from 'node:fs/promises'
import { createGunzip } from 'node:zlib'
import { Readable } from 'node:stream'
import tar from 'tar-stream'
import { buildCapabilityBaseline } from './contract/build-capability-baseline'
import { findMajorProblems, type ContractSnapshot } from './contract/capability-majors'

// Fails when a capability contract changed incompatibly since the last
// published SDK without a major bump. The baseline is the
// `dist/contract/capability-baseline.json` the published package carries, so a
// break that was introduced and reverted between releases needs no bump.
//
//   npm run contract:check-majors                          # baseline: @qvac/sdk@latest
//   npm run contract:check-majors -- --baseline-file <path> # baseline: a local file

const PACKAGE = '@qvac/sdk'
const BASELINE_PATH = 'package/dist/contract/capability-baseline.json'

function argument(name: string): string | undefined {
  const index = process.argv.indexOf(name)
  return index === -1 ? undefined : process.argv[index + 1]
}

async function readFromTarball(url: string, path: string): Promise<string | undefined> {
  const response = await fetch(url)
  if (!response.ok || !response.body) {
    throw new Error(`downloading ${url} answered ${response.status}`)
  }
  const extract = tar.extract()
  let found: string | undefined
  extract.on('entry', (header, stream, next) => {
    const chunks: Buffer[] = []
    stream.on('data', (chunk: unknown) => {
      if (header.name === path) chunks.push(chunk as Buffer)
    })
    stream.on('end', () => {
      if (header.name === path) found = Buffer.concat(chunks).toString('utf8')
      next()
    })
    stream.resume()
  })
  const done = new Promise<void>((resolve, reject) => {
    extract.on('finish', resolve)
    extract.on('error', reject)
  })
  Readable.fromWeb(response.body as never)
    .pipe(createGunzip())
    .pipe(extract)
  await done
  return found
}

async function publishedBaseline(): Promise<{ label: string; content: string | undefined }> {
  const response = await fetch(`https://registry.npmjs.org/${PACKAGE.replace('/', '%2f')}/latest`)
  if (!response.ok) throw new Error(`npm registry answered ${response.status} for ${PACKAGE}`)
  const manifest = (await response.json()) as { version: string; dist: { tarball: string } }
  return {
    label: `${PACKAGE}@${manifest.version}`,
    content: await readFromTarball(manifest.dist.tarball, BASELINE_PATH)
  }
}

const file = argument('--baseline-file')
const baseline = file
  ? { label: file, content: await readFile(file, 'utf8') }
  : await publishedBaseline()

if (baseline.content === undefined) {
  console.log(`${baseline.label} carries no capability baseline; nothing to compare.`)
  process.exit(0)
}

const problems = findMajorProblems(
  JSON.parse(baseline.content) as ContractSnapshot,
  buildCapabilityBaseline()
)
if (problems.length > 0) {
  console.error(`Capability contracts changed incompatibly since ${baseline.label}:`)
  for (const problem of problems) console.error(`  - ${problem}`)
  console.error(
    'Bump the major of each contract above in CAPABILITY_CONTRACTS, or make the change compatible.'
  )
  process.exit(1)
}
console.log(`Capability contracts are compatible with ${baseline.label}.`)
