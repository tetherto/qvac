'use strict'

const fs = require('fs')
const os = require('os')
const path = require('path')
const { spawnSync } = require('child_process')
const { builtinModules } = require('module')
const test = require('brittle')

// The lexer must be the one `bare-pack` (the mobile bundler) resolves, not an
// ambient copy — the desync this test hunts for differs between lexer
// releases. Mirrors scripts/ci/check-bundler-requires.mjs.
const BARE_PACK_ROOT = path.dirname(require.resolve('bare-pack/package'))
const lex = require(require.resolve('bare-module-lexer', { paths: [BARE_PACK_ROOT] }))

const PACKAGE_ROOT = path.resolve(__dirname, '..', '..')
const COMMAND_NAME = 'qvac-audiogen-download-models'
const DOWNLOADER_PATH = 'scripts/download-audiogen-ggml-models.js'
const REPOSITORY_DOWNLOAD_COMMAND =
  'node scripts/download-audiogen-ggml-models.js --output ./models'
const IS_WINDOWS = process.platform === 'win32'
const NPM_COMMAND = IS_WINDOWS ? 'npm.cmd' : 'npm'
const PACKAGE_NAME = '@qvac/audiogen-ggml'
const IMPORT_PATTERN = /require\(\s*['"]([^'"]+)['"]\s*\)/g
const BUILTIN_MODULES = new Set(builtinModules.flatMap((name) => [name, `node:${name}`]))
const BENCHMARK_PATHS = [
  'package/benchmarks/RTF-BENCHMARKS.md',
  'package/test/utils/benchmark-report.js',
  'package/test/utils/benchmark-runner.js',
  'package/test/utils/benchmark-stats.js',
  'package/test/utils/benchmark-validate.js',
  'package/test/utils/device-env.js',
  'package/test/utils/downloadModel.js',
  'package/test/utils/memory-usage.js',
  'package/test/utils/runAudioGen.js'
]
const REQUIRED_PATHS = [
  'package/index.js',
  'package/index.d.ts',
  'package/audiogen.js',
  'package/audiogen.d.ts',
  'package/error.js',
  'package/error.d.ts',
  'package/examples/generate-music-minimax.js',
  'package/NOTICE',
  'package/scripts/download-audiogen-ggml-models.js',
  ...BENCHMARK_PATHS
]
const FORBIDDEN_PREFIXES = ['package/test/integration/', 'package/test/mobile/']
const SOURCE_ROOT = path.join(PACKAGE_ROOT, 'src')

function run(command, args, cwd) {
  const result = spawnSync(command, args, { cwd, encoding: 'utf8' })
  if (result.error) throw result.error
  if (result.status !== 0) {
    throw new Error(`${command} failed: ${result.stderr || result.stdout}`)
  }
  return result.stdout
}

function installTarball(consumerRoot, tarballPath) {
  fs.mkdirSync(consumerRoot)
  fs.writeFileSync(
    path.join(consumerRoot, 'package.json'),
    `${JSON.stringify({ name: 'audiogen-package-consumer', private: true }, null, 2)}\n`
  )
  run(
    NPM_COMMAND,
    [
      'install',
      '--ignore-scripts',
      '--omit=dev',
      '--no-audit',
      '--no-fund',
      '--no-package-lock',
      tarballPath
    ],
    consumerRoot
  )
}

function packageNameFromSpecifier(specifier) {
  return specifier.startsWith('@')
    ? specifier.split('/').slice(0, 2).join('/')
    : specifier.split('/')[0]
}

function importedModules(source) {
  return [...source.matchAll(IMPORT_PATTERN)].map((match) => match[1])
}

function isExternalModule(specifier) {
  return (
    !specifier.startsWith('.') &&
    !specifier.startsWith('/') &&
    !BUILTIN_MODULES.has(specifier) &&
    packageNameFromSpecifier(specifier) !== PACKAGE_NAME
  )
}

function assertDeclaredImports(t, packageRoot, entries, packageJson) {
  const declaredModules = new Set([
    ...Object.keys(packageJson.dependencies || {}),
    ...Object.keys(packageJson.peerDependencies || {})
  ])
  const scriptEntries = entries.filter(
    (entry) => entry.startsWith('package/') && /\.(?:c?js|mjs)$/.test(entry)
  )
  scriptEntries.forEach((entry) => {
    const source = fs.readFileSync(path.join(packageRoot, entry.slice('package/'.length)), 'utf8')
    importedModules(source)
      .filter(isExternalModule)
      .forEach((specifier) => {
        const moduleName = packageNameFromSpecifier(specifier)
        if (moduleName === '@qvac/registry-client') return
        t.ok(declaredModules.has(moduleName), `${entry} declares ${moduleName}`)
      })
  })
}

// `exports.<name>` anywhere inside a template-literal substitution derails
// bare-module-lexer: every require() later in that file is dropped from the
// bare-pack mobile bundle (this is how ./binding went missing on Device Farm).
// tsc rewrites references to exported consts into that form, so interpolating
// them is the pattern to ban. The scan stops at the substitution's first `}`,
// which covers every shape tsc emits for a const reference.
const LEXER_BREAKING_PATTERN = /\$\{[^}]*\bexports\./

function assertMobileBundlerLexable(t, packageRoot, entries) {
  const scriptEntries = entries.filter(
    (entry) => entry.startsWith('package/') && /\.(?:c?js|mjs)$/.test(entry)
  )
  scriptEntries.forEach((entry) => {
    const source = fs.readFileSync(path.join(packageRoot, entry.slice('package/'.length)), 'utf8')
    t.absent(
      LEXER_BREAKING_PATTERN.test(source),
      `${entry} avoids \${exports.*} template substitutions (breaks bare-module-lexer)`
    )
  })
}

function assertRuntimePathsResolve(t, consumerRoot) {
  const probe = `
require.resolve('@qvac/audiogen-ggml')
require.resolve('@qvac/audiogen-ggml/test/benchmark-runner')
require.resolve('bare-process')
`
  const result = spawnSync(process.execPath, ['-e', probe], {
    cwd: consumerRoot,
    encoding: 'utf8'
  })
  t.is(result.status, 0, result.stderr || result.stdout)
}

function assertRequiredPaths(t, entries) {
  for (const requiredPath of REQUIRED_PATHS) {
    t.ok(entries.includes(requiredPath), `tarball includes ${requiredPath}`)
  }
}

function isInternalTestUtility(entry) {
  return entry.startsWith('package/test/utils/') && !BENCHMARK_PATHS.includes(entry)
}

function assertForbiddenPaths(t, entries) {
  for (const prefix of FORBIDDEN_PREFIXES) {
    t.absent(
      entries.some((entry) => entry.startsWith(prefix)),
      `tarball excludes ${prefix}`
    )
  }
  t.absent(entries.some(isInternalTestUtility), 'tarball excludes internal test utilities')
}

function walkFiles(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const entryPath = path.join(directory, entry.name)
    return entry.isDirectory() ? walkFiles(entryPath) : [entryPath]
  })
}

function generatedScripts() {
  return walkFiles(SOURCE_ROOT)
    .filter((filePath) => filePath.endsWith('.ts') && !filePath.endsWith('.d.ts'))
    .map((filePath) => `${path.relative(SOURCE_ROOT, filePath).slice(0, -'.ts'.length)}.js`)
    .map((filePath) => filePath.split(path.sep).join('/'))
    .filter((filePath) => fs.existsSync(path.join(PACKAGE_ROOT, filePath)))
}

function relativeSpecifiers(specifiers) {
  return new Set(specifiers.filter((specifier) => specifier.startsWith('.')))
}

function lexedSpecifiers(source) {
  return lex(Buffer.from(source)).imports.map((entry) => entry.specifier)
}

function assertBundlerSeesRequires(t, scriptPath) {
  const source = fs.readFileSync(path.join(PACKAGE_ROOT, scriptPath), 'utf8')
  const written = relativeSpecifiers(importedModules(source))
  const lexed = relativeSpecifiers(lexedSpecifiers(source))
  for (const specifier of written) {
    t.ok(lexed.has(specifier), `bare-pack resolves ${specifier} from ${scriptPath}`)
  }
}

function runDownloader(downloaderPath, cwd) {
  if (IS_WINDOWS) return run(process.execPath, [downloaderPath, '--help'], cwd)
  fs.accessSync(downloaderPath, fs.constants.X_OK)
  return run(downloaderPath, ['--help'], cwd)
}

function runDownloaderWithoutOutput(downloaderPath, cwd) {
  const command = IS_WINDOWS ? process.execPath : downloaderPath
  const args = IS_WINDOWS ? [downloaderPath] : []
  return spawnSync(command, args, { cwd, encoding: 'utf8' })
}

function runDownloaderWithoutRegistryClient(downloaderPath, cwd) {
  const outputPath = path.join(cwd, 'models')
  return spawnSync(process.execPath, [downloaderPath, '--output', outputPath], {
    cwd,
    encoding: 'utf8'
  })
}

test('published package contains only consumer contract files', (t) => {
  const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'audiogen-pack-'))
  t.teardown(() => fs.rmSync(temporaryDirectory, { recursive: true, force: true }))

  const packOutput = run(
    NPM_COMMAND,
    ['pack', '--ignore-scripts', '--json', '--pack-destination', temporaryDirectory],
    PACKAGE_ROOT
  )
  const [{ filename }] = JSON.parse(packOutput)
  const tarballPath = path.join(temporaryDirectory, filename)
  const entries = run('tar', ['-tzf', tarballPath], temporaryDirectory).trim().split('\n')

  assertRequiredPaths(t, entries)
  assertForbiddenPaths(t, entries)

  run('tar', ['-xzf', tarballPath], temporaryDirectory)
  const packedPackageRoot = path.join(temporaryDirectory, 'package')
  const packedPackage = JSON.parse(
    fs.readFileSync(path.join(packedPackageRoot, 'package.json'), 'utf8')
  )
  t.is(
    packedPackage.exports['./test/benchmark-runner'],
    './test/utils/benchmark-runner.js',
    'package exposes the documented benchmark runner'
  )
  t.is(packedPackage.bin[COMMAND_NAME], DOWNLOADER_PATH, 'package exposes downloader bin')
  t.is(
    packedPackage.scripts['download-models:registry'],
    REPOSITORY_DOWNLOAD_COMMAND,
    'repository downloader targets the integration model cache'
  )
  t.absent(
    packedPackage.dependencies['@qvac/registry-client'],
    'package does not install the optional downloader runtime for every consumer'
  )
  t.absent(
    packedPackage.peerDependencies && packedPackage.peerDependencies['@qvac/registry-client'],
    'package does not declare the downloader runtime as a peer'
  )
  t.is(
    packedPackage.devDependencies['@qvac/registry-client'],
    '^0.6.1',
    'package keeps the downloader runtime as a hyperdb-v6 aligned devDependency'
  )
  t.is(
    packedPackage.dependencies['bare-process'],
    '^4.2.2',
    'package installs the benchmark process runtime'
  )
  assertDeclaredImports(t, packedPackageRoot, entries, packedPackage)
  assertMobileBundlerLexable(t, packedPackageRoot, entries)
  const consumerRoot = path.join(temporaryDirectory, 'consumer')
  installTarball(consumerRoot, tarballPath)
  assertRuntimePathsResolve(t, consumerRoot)
  const downloaderPath = path.join(packedPackageRoot, DOWNLOADER_PATH)
  const help = runDownloader(downloaderPath, packedPackageRoot)
  t.ok(help.includes(COMMAND_NAME), 'downloader help uses stable command')
  t.ok(help.includes('--output'), 'downloader help documents output')
  const missingOutput = runDownloaderWithoutOutput(downloaderPath, packedPackageRoot)
  t.is(missingOutput.status, 1, 'downloader rejects a missing output directory')
  t.ok(missingOutput.stderr.includes('--output is required'), 'downloader reports required output')
  const missingRegistryClient = runDownloaderWithoutRegistryClient(
    downloaderPath,
    packedPackageRoot
  )
  t.is(missingRegistryClient.status, 1, 'downloader rejects a missing optional registry client')
  t.ok(
    missingRegistryClient.stderr.includes('Install @qvac/registry-client'),
    'downloader explains how to install its optional runtime'
  )
})

test('generated scripts keep every relative require visible to the bundler', (t) => {
  const scripts = generatedScripts()
  t.ok(scripts.includes('index.js'), 'entry point is a generated script')
  scripts.forEach((scriptPath) => assertBundlerSeesRequires(t, scriptPath))
})
