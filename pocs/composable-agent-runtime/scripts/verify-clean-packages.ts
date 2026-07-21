import { mkdtemp, mkdir, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const root = new URL('..', import.meta.url).pathname
const packagesDirectory = join(root, 'packages')
const packageNames = [
  '@qvac/runtime-contracts',
  '@qvac/supervisor',
  '@qvac/agents',
  '@qvac/sync',
  '@qvac/harness',
  '@qvac/assistant'
] as const
const subsets = new Map<string, readonly string[]>([
  ['supervisor', ['@qvac/supervisor']],
  ['agents', ['@qvac/agents']],
  ['sync', ['@qvac/runtime-contracts', '@qvac/sync']],
  [
    'harness',
    [
      '@qvac/runtime-contracts',
      '@qvac/supervisor',
      '@qvac/agents',
      '@qvac/sync',
      '@qvac/harness'
    ]
  ],
  ['assistant', packageNames]
])

const temporary = await mkdtemp(join(tmpdir(), 'qvac-agent-runtime-pack-'))

try {
  const tarballs = await packPackages()
  for (const [name, dependencies] of subsets) {
    await verifySubset(name, dependencies, tarballs)
  }
  console.log(`clean package subsets passed: ${[...subsets.keys()].join(', ')}`)
} finally {
  await rm(temporary, { recursive: true, force: true })
}

async function packPackages() {
  const output = join(temporary, 'tarballs')
  await mkdir(output, { recursive: true })
  const tarballs = new Map<string, string>()

  for (const packageName of packageNames) {
    const directory = join(packagesDirectory, packageName.slice('@qvac/'.length))
    const before = new Set(await readdir(output))
    await run(['npm', 'pack', '--ignore-scripts', '--pack-destination', output], directory)
    const filename = (await readdir(output)).find((candidate) => !before.has(candidate))
    if (!filename) throw new Error(`npm pack did not produce a tarball for ${packageName}`)
    tarballs.set(packageName, join(output, filename))
  }
  return tarballs
}

async function verifySubset(
  name: string,
  dependencies: readonly string[],
  tarballs: ReadonlyMap<string, string>
) {
  const directory = join(temporary, name)
  await mkdir(directory, { recursive: true })
  const manifest = {
    name: `clean-${name}-consumer`,
    private: true,
    type: 'module',
    dependencies: Object.fromEntries(
      dependencies.map((dependency) => {
        const tarball = tarballs.get(dependency)
        if (!tarball) throw new Error(`missing tarball for ${dependency}`)
        return [dependency, `file:${tarball}`]
      })
    )
  }
  await writeFile(join(directory, 'package.json'), `${JSON.stringify(manifest, null, 2)}\n`)
  await writeFile(
    join(directory, 'smoke.ts'),
    `${dependencies.map((dependency) => `await import('${dependency}')`).join('\n')}\n`
  )
  await run(['npm', 'install', '--ignore-scripts'], directory)
  await run(['bun', 'run', 'smoke.ts'], directory)
}

async function run(command: readonly string[], cwd: string) {
  const child = Bun.spawn(command, {
    cwd,
    stdout: 'pipe',
    stderr: 'pipe'
  })
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text()
  ])
  if (exitCode !== 0) {
    throw new Error(
      `${command.join(' ')} failed in ${cwd}\n${stdout.trim()}\n${stderr.trim()}`.trim()
    )
  }
}
