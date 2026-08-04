import { access, mkdtemp, mkdir, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const root = new URL('..', import.meta.url).pathname
const packageDirectories = new Map([
  ['@qvac/supervisor', join(root, 'packages', 'supervisor')],
  ['@qvac/agents', join(root, 'packages', 'agents')],
  ['@qvac/sync', join(root, 'packages', 'sync')],
  ['@qvac/harness', join(root, 'packages', 'harness')],
  ['@qvac/assistant', join(root, 'packages', 'assistant')],
  ['@qvac-poc/skill-cli', join(root, 'apps', 'skill-cli')]
])
const packageNames = [...packageDirectories.keys()]
const libraryPackageNames = packageNames.filter(
  (name) => name !== '@qvac-poc/skill-cli'
)
const subsets = new Map<string, readonly string[]>([
  ['supervisor', ['@qvac/supervisor']],
  ['agents', ['@qvac/agents']],
  ['sync', ['@qvac/supervisor', '@qvac/sync']],
  [
    'harness',
    [
      '@qvac/supervisor',
      '@qvac/agents',
      '@qvac/sync',
      '@qvac/harness'
    ]
  ],
  ['assistant', libraryPackageNames],
  [
    'skill-cli',
    [
      '@qvac/supervisor',
      '@qvac/agents',
      '@qvac/harness',
      '@qvac-poc/skill-cli'
    ]
  ]
])

const expoConsumerDeps = {
  'bare-link': '^3.3.0',
  expo: '^54.0.33',
  'expo-build-properties': '~1.0.10',
  react: '19.1.0',
  'react-native': '0.81.5',
  'react-native-bare-kit': '^0.14.0'
} as const

const sdkNativeOverrides = {
  'bare-process': '4.5.0',
  'bare-tty': '5.1.1'
} as const

const mobileConsumers = [
  {
    name: 'sync-standalone',
    slug: 'clean-sync-consumer',
    androidPackage: 'com.qvac.poc.cleansync',
    plugin: '@qvac/sync/expo-plugin',
    localPackages: ['@qvac/supervisor', '@qvac/sync'] as const,
    includeSdk: false,
    includeOverrides: true,
    expectedPaths: [
      'android',
      'qvac/contributions/sync.json',
      'qvac/sync-stack.validation.json',
      'qvac/addons.manifest.json'
    ],
    validationPath: 'qvac/sync-stack.validation.json',
    contributionPath: 'qvac/contributions/sync.json',
    expectedContribution: {
      packageName: '@qvac/sync',
      contract: 'qvac.sync'
    }
  },
  {
    name: 'harness-standalone',
    slug: 'clean-harness-consumer',
    androidPackage: 'com.qvac.poc.cleanharness',
    plugin: '@qvac/harness/expo-plugin',
    localPackages: [
      '@qvac/supervisor',
      '@qvac/agents',
      '@qvac/sync',
      '@qvac/harness'
    ] as const,
    includeSdk: true,
    includeOverrides: true,
    expectedPaths: [
      'android',
      'qvac/contributions/harness.json',
      'qvac/harness-stack.validation.json',
      'qvac/addons.manifest.json'
    ],
    validationPath: 'qvac/harness-stack.validation.json',
    contributionPath: 'qvac/contributions/harness.json',
    expectedContribution: {
      packageName: '@qvac/harness',
      contract: 'qvac.harness'
    }
  },
  {
    name: 'assistant-fullstack',
    slug: 'clean-assistant-consumer',
    androidPackage: 'com.qvac.poc.cleanassistant',
    plugin: '@qvac/assistant/expo-plugin',
    localPackages: packageNames,
    includeSdk: true,
    includeOverrides: true,
    expectedPaths: [
      'android',
      'qvac/contributions/sync.json',
      'qvac/contributions/harness.json',
      'qvac/addons.manifest.json',
      'qvac/assistant-stack.manifest.json',
      'qvac/assistant-stack.validation.json'
    ],
    validationPath: 'qvac/assistant-stack.validation.json',
    contributionPath: null,
    expectedContribution: null
  }
] as const

const temporary = await mkdtemp(join(tmpdir(), 'qvac-agent-runtime-pack-'))

try {
  const tarballs = await packPackages()
  for (const [name, dependencies] of subsets) {
    await verifySubset(name, dependencies, tarballs)
  }
  for (const consumer of mobileConsumers) {
    await verifyMobileConsumer(consumer, tarballs)
  }
  console.log(
    `clean package subsets passed: ${[...subsets.keys()].join(', ')}; mobile consumers: ${mobileConsumers
      .map((consumer) => consumer.name)
      .join(', ')}`
  )
} finally {
  await rm(temporary, { recursive: true, force: true })
}

async function packPackages() {
  const output = join(temporary, 'tarballs')
  await mkdir(output, { recursive: true })
  const tarballs = new Map<string, string>()

  for (const packageName of packageNames) {
    const directory = packageDirectories.get(packageName)
    if (!directory) throw new Error(`missing package directory: ${packageName}`)
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
    `${dependencies
      .filter((dependency) => dependency !== '@qvac-poc/skill-cli')
      .map((dependency) => `await import('${dependency}')`)
      .join('\n')}\n`
  )
  await run(['npm', 'install', '--ignore-scripts'], directory)
  if (dependencies.includes('@qvac/harness')) {
    await verifyHarnessSkillPackaging(directory)
  }
  if (dependencies.includes('@qvac-poc/skill-cli')) {
    await verifySkillCliPackaging(directory)
  }
  await run(['bun', 'run', 'smoke.ts'], directory)
  await rm(directory, { recursive: true, force: true })
}

async function verifyMobileConsumer(
  consumer: (typeof mobileConsumers)[number],
  tarballs: ReadonlyMap<string, string>
) {
  const directory = join(temporary, consumer.name)
  await mkdir(directory, { recursive: true })
  const localPackages = Object.fromEntries(
    consumer.localPackages.map((packageName) => {
      const tarball = tarballs.get(packageName)
      if (!tarball) throw new Error(`missing tarball for ${packageName}`)
      return [packageName, `file:${tarball}`]
    })
  )
  await writeFile(
    join(directory, 'package.json'),
    `${JSON.stringify(
      {
        name: `clean-${consumer.name}-consumer`,
        private: true,
        version: '0.0.0',
        main: 'index.ts',
        dependencies: {
          ...localPackages,
          ...(consumer.includeSdk ? { '@qvac/sdk': '^0.15.0' } : {}),
          ...expoConsumerDeps
        },
        ...(consumer.includeOverrides ? { overrides: sdkNativeOverrides } : {})
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
          name: `Clean ${consumer.name} Consumer`,
          slug: consumer.slug,
          android: {
            package: consumer.androidPackage
          },
          plugins: [consumer.plugin]
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
  for (const relativePath of consumer.expectedPaths) {
    await access(join(directory, relativePath))
  }
  await assertValidationOk(join(directory, consumer.validationPath))
  if (consumer.contributionPath && consumer.expectedContribution) {
    await assertContribution(
      join(directory, consumer.contributionPath),
      consumer.expectedContribution
    )
  }
  if (
    consumer.name === 'sync-standalone' ||
    consumer.name === 'harness-standalone'
  ) {
    await assertManifestAwareBareKitLinkers(directory)
  }
  if (consumer.name === 'assistant-fullstack') {
    await assertContribution(join(directory, 'qvac/contributions/sync.json'), {
      packageName: '@qvac/sync',
      contract: 'qvac.sync'
    })
    await assertContribution(join(directory, 'qvac/contributions/harness.json'), {
      packageName: '@qvac/harness',
      contract: 'qvac.harness'
    })
    const stackManifest = JSON.parse(
      await readFile(join(directory, 'qvac/assistant-stack.manifest.json'), 'utf8')
    ) as { pluginExecutionOrder?: unknown }
    if (
      !Array.isArray(stackManifest.pluginExecutionOrder) ||
      stackManifest.pluginExecutionOrder.join(',') !==
        'sync-contributor-plugin,harness-contributor-plugin,invoke-sdk-expo-plugin,finalize-assistant-stack'
    ) {
      throw new Error(
        `unexpected assistant pluginExecutionOrder: ${JSON.stringify(stackManifest.pluginExecutionOrder)}`
      )
    }
  }
  // Drop each Expo tree before the next consumer so disk pressure stays bounded.
  await rm(directory, { recursive: true, force: true })
}

async function assertManifestAwareBareKitLinkers(projectRoot: string) {
  const expectedRoot = await realpath(projectRoot)
  for (const relativePath of ['android/link.mjs', 'ios/link.mjs']) {
    const linkerPath = join(projectRoot, 'node_modules', 'react-native-bare-kit', relativePath)
    const source = await readFile(linkerPath, 'utf8')
    const declaredRoot = extractDeclaredProjectRoot(source, linkerPath)
    let canonicalDeclaredRoot: string
    try {
      canonicalDeclaredRoot = await realpath(declaredRoot)
    } catch (error) {
      throw new Error(
        `BareKit linker projectRoot does not resolve on disk at ${linkerPath}: ${declaredRoot}` +
          ` (${error instanceof Error ? error.message : String(error)})`
      )
    }
    if (canonicalDeclaredRoot !== expectedRoot) {
      throw new Error(
        `BareKit linker projectRoot mismatch at ${linkerPath}:` +
          ` declared ${declaredRoot} (realpath ${canonicalDeclaredRoot}),` +
          ` expected realpath ${expectedRoot}`
      )
    }
    if (!source.includes("path.join(projectRoot, 'qvac', 'addons.manifest.json')")) {
      throw new Error(`BareKit linker is not manifest-aware: ${linkerPath}`)
    }
    if (source.includes("path.join(__filename, '..', '..', '..', '..')")) {
      throw new Error(`BareKit linker still has stock project-root resolution: ${linkerPath}`)
    }
  }
}

function extractDeclaredProjectRoot(source: string, linkerPath: string) {
  const match = /^const projectRoot = (.+)$/m.exec(source)
  if (!match) {
    throw new Error(`BareKit linker missing projectRoot declaration: ${linkerPath}`)
  }
  const expression = match[1]?.trim()
  if (!expression) {
    throw new Error(`BareKit linker has empty projectRoot declaration: ${linkerPath}`)
  }
  let declaredRoot: unknown
  try {
    declaredRoot = JSON.parse(expression)
  } catch (error) {
    throw new Error(
      `BareKit linker has malformed projectRoot declaration at ${linkerPath}: ${expression}` +
        ` (${error instanceof Error ? error.message : String(error)})`
    )
  }
  if (typeof declaredRoot !== 'string' || declaredRoot.length === 0) {
    throw new Error(
      `BareKit linker projectRoot must be a non-empty string at ${linkerPath}: ${expression}`
    )
  }
  return declaredRoot
}

async function assertValidationOk(path: string) {
  const report = JSON.parse(await readFile(path, 'utf8')) as {
    ok?: boolean
    errors?: unknown
  }
  if (report.ok !== true) {
    throw new Error(
      `validation report is not ok at ${path}: ${JSON.stringify(report.errors ?? report)}`
    )
  }
}

async function assertContribution(
  path: string,
  expected: { packageName: string; contract: string }
) {
  const contribution = JSON.parse(await readFile(path, 'utf8')) as {
    packageName?: string
    contract?: string
    schemaVersion?: number
    protocolVersion?: number
  }
  if (contribution.packageName !== expected.packageName) {
    throw new Error(
      `contribution packageName mismatch at ${path}: ${contribution.packageName}`
    )
  }
  if (contribution.contract !== expected.contract) {
    throw new Error(`contribution contract mismatch at ${path}: ${contribution.contract}`)
  }
  if (contribution.schemaVersion !== 1 || contribution.protocolVersion !== 1) {
    throw new Error(`contribution versions invalid at ${path}: ${JSON.stringify(contribution)}`)
  }
}

async function verifyHarnessSkillPackaging(directory: string) {
  const required = [
    'node_modules/@qvac/harness/lib/skills/bundled-skills.ts',
    'node_modules/@qvac/harness/lib/skills/materialize.ts',
    'node_modules/@qvac/harness/tool-sandbox-child-entry.ts',
    'node_modules/@qvac/harness/spec/tool-sandbox/hrpc/index.js',
    'node_modules/@qvac/harness/spec/tool-sandbox/hrpc/index.d.ts',
    'node_modules/@qvac/harness/skills/weather/SKILL.md',
    'node_modules/@qvac/harness/skills/obsidian/SKILL.md',
    'node_modules/@qvac/harness/skills/obsidian/cli.schema.json',
    'node_modules/@qvac/harness/skills/image-generation/SKILL.md'
  ]
  for (const relativePath of required) {
    await access(join(directory, relativePath))
  }
}

async function verifySkillCliPackaging(directory: string) {
  const packageRoot = join(directory, 'node_modules', '@qvac-poc', 'skill-cli')
  for (const relativePath of [
    'index.ts',
    'bare-probe.ts',
    'runner.ts',
    'scripts/build-sandbox.ts',
    'README.md'
  ]) {
    await access(join(packageRoot, relativePath))
  }
  await run(['bun', 'run', 'build:sandbox'], packageRoot)
  await run(
    ['bare', 'index.ts', 'smoke', '--timeout-ms=5000'],
    packageRoot
  )
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
