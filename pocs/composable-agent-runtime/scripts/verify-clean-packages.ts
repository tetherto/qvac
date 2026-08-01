import { access, mkdtemp, mkdir, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const root = new URL('..', import.meta.url).pathname
const packagesDirectory = join(root, 'packages')
const packageNames = [
  '@qvac/supervisor',
  '@qvac/agents',
  '@qvac/sync',
  '@qvac/harness',
  '@qvac/assistant'
] as const
const subsets = new Map<string, readonly string[]>([
  ['supervisor', ['@qvac/supervisor']],
  ['agents', ['@qvac/agents']],
  ['sync', ['@qvac/supervisor', '@qvac/sync']],
  [
    'harness',
    [
      '@qvac/supervisor',
      '@qvac/agents',
      '@qvac/harness'
    ]
  ],
  ['assistant', packageNames]
])

const temporary = await mkdtemp(join(tmpdir(), 'qvac-agent-runtime-pack-'))

try {
  const tarballs = await packPackages()
  await verifyMobileConsumer(tarballs)
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

async function verifyMobileConsumer(tarballs: ReadonlyMap<string, string>) {
  const directory = join(temporary, 'mobile-consumer')
  await mkdir(directory, { recursive: true })
  const localPackages = Object.fromEntries(
    packageNames.map((packageName) => {
      const tarball = tarballs.get(packageName)
      if (!tarball) throw new Error(`missing tarball for ${packageName}`)
      return [packageName, `file:${tarball}`]
    })
  )
  await writeFile(
    join(directory, 'package.json'),
    `${JSON.stringify(
      {
        name: 'clean-assistant-mobile-consumer',
        private: true,
        version: '0.0.0',
        main: 'index.ts',
        dependencies: {
          ...localPackages,
          '@qvac/sdk': '^0.15.0',
          'bare-link': '^3.3.0',
          expo: '^54.0.33',
          'expo-build-properties': '~1.0.10',
          react: '19.1.0',
          'react-native': '0.81.5',
          'react-native-bare-kit': '^0.14.0'
        },
        overrides: {
          'bare-process': '4.5.0',
          'bare-tty': '5.1.1'
        }
      },
      null,
      2
    )}\n`
  )
  await writeFile(
    join(directory, 'app.json'),
    `${JSON.stringify(
      {
        expo: {
          name: 'Clean Assistant Consumer',
          slug: 'clean-assistant-consumer',
          android: {
            package: 'com.qvac.poc.cleanassistant'
          },
          plugins: ['@qvac/assistant/expo-plugin']
        }
      },
      null,
      2
    )}\n`
  )
  await writeFile(
    join(directory, 'index.ts'),
    "import { registerRootComponent } from 'expo'\nimport App from './App'\nregisterRootComponent(App)\n"
  )
  await writeFile(
    join(directory, 'App.tsx'),
    "import { Text } from 'react-native'\nexport default function App() { return <Text>Clean consumer</Text> }\n"
  )
  await run(['npm', 'install', '--ignore-scripts'], directory)
  await run(
    ['npx', 'expo', 'prebuild', '--clean', '--platform', 'android', '--no-install'],
    directory
  )
  await access(join(directory, 'android'))
  await access(join(directory, 'qvac', 'assistant-stack.manifest.json'))
  await access(join(directory, 'qvac', 'assistant-stack.validation.json'))
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
