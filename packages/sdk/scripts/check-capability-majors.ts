import { readFile } from 'node:fs/promises'
import { createGunzip } from 'node:zlib'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import tar from 'tar-stream'
import { buildCapabilityBaseline } from './contract/build-capability-baseline'
import {
  baselineVersion,
  findMajorProblems,
  type ContractSnapshot
} from './contract/capability-majors'

// Fails when a capability contract changed incompatibly since the last
// published SDK without a major bump. The baseline is the
// `dist/contract/capability-baseline.json` the published package carries, so a
// break that was introduced and reverted between releases needs no bump.
//
//   npm run contract:check-majors                          # baseline: highest @qvac/sdk ≤ this version
//   npm run contract:check-majors -- --baseline-file <path> # baseline: a local file

const PACKAGE = '@qvac/sdk'
const BASELINE_PATH = 'package/dist/contract/capability-baseline.json'
const ATTEMPTS = 3

function argument(name: string): string | undefined {
  const index = process.argv.indexOf(name)
  return index === -1 ? undefined : process.argv[index + 1]
}

// A failed download must not read as a contract break: it is retried, then
// reported as a download failure.
async function download(url: string): Promise<Response> {
  let failure = ''
  for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
    try {
      const response = await fetch(url)
      if (response.ok && response.body) return response
      failure = `${url} answered ${response.status}`
      if (response.status < 500) break
    } catch (error) {
      failure = `${url}: ${(error as Error).message}`
    }
  }
  throw new Error(failure)
}

async function readFromTarball(url: string, path: string): Promise<string | undefined> {
  const response = await download(url)
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
  await pipeline(Readable.fromWeb(response.body as never), createGunzip(), extract)
  return found
}

async function publishedBaseline(): Promise<{ label: string; content: string | undefined }> {
  const own = (
    JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8')) as {
      version: string
    }
  ).version
  const packument = (await (
    await download(`https://registry.npmjs.org/${encodeURIComponent(PACKAGE)}`)
  ).json()) as { versions: Record<string, { dist: { tarball: string } }> }
  const version = baselineVersion(Object.keys(packument.versions), own)
  if (version === undefined) {
    return { label: `no published ${PACKAGE} at or below ${own}`, content: undefined }
  }
  return {
    label: `${PACKAGE}@${version}`,
    content: await readFromTarball(packument.versions[version]!.dist.tarball, BASELINE_PATH)
  }
}

async function loadBaseline(): Promise<{ label: string; content: string | undefined }> {
  const file = argument('--baseline-file')
  if (file) return { label: file, content: await readFile(file, 'utf8') }
  try {
    return await publishedBaseline()
  } catch (error) {
    console.error(
      `Could not read the published capability baseline: ${(error as Error).message}. ` +
        'This is a download failure, not a contract change.'
    )
    process.exit(1)
  }
}

const baseline = await loadBaseline()

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
