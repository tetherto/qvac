// Fails when a shipped JavaScript file hides a relative `require` from
// `bare-module-lexer`, the scanner `bare-pack` uses to walk the module graph.
//
// A lexer desync is invisible at build time: `bare-pack` exits 0 and writes a
// bundle that silently omits every module discovered after the desync point.
// The omission only surfaces on device, as `MODULE_NOT_FOUND` for a module that
// is plainly present in the published tarball.
//
// Usage: node scripts/ci/check-bundler-requires.mjs [packageDir]

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { createRequire } from 'node:module'
import { spawnSync } from 'node:child_process'

const LEXER_PACKAGE = 'bare-module-lexer'
// The mobile app bundle is produced by `bare-pack`, so the lexer has to be the
// one `bare-pack` itself resolves. Reading it out of an ambient `node_modules`
// picks up whatever version happens to be hoisted nearby, and the desync this
// check hunts for differs between lexer releases.
const BUNDLER_SPEC = 'bare-pack@^1.4.7'
// bare-module-lexer 1.6.6 ships prebuilds that call node_api_is_sharedarraybuffer,
// a Bare extension plain node does not export, so requiring it here aborts the
// process. Pin the last node-loadable release until upstream ships one again.
const LEXER_OVERRIDES = { [LEXER_PACKAGE]: '1.6.3' }
const REQUIRE_PATTERN = /require\(\s*['"]([^'"]+)['"]\s*\)/g
// Directory names that never enter a mobile bundle. Generators under `scripts/`
// and fixtures under `test/` embed require-looking strings in output text
// (scanning them produced false positives across six packages); the rest are
// build outputs, dev-only trees, or native sources. Every other directory is
// walked, so multi-directory runtime graphs (e.g. asr-ggml's `engines/`) are
// covered.
const EXCLUDED_DIRECTORY_NAMES = new Set([
  'node_modules',
  'scripts',
  'test',
  'tests',
  'benchmarks',
  'examples',
  'build',
  'prebuilds',
  'dist',
  'coverage',
  'addon'
])
const EXIT_HIDDEN_REQUIRE = 1
const EXIT_INFRASTRUCTURE = 2

function packageDirectory() {
  return path.resolve(process.argv[2] ?? '.')
}

function isScript(name) {
  return name.endsWith('.js') || name.endsWith('.cjs')
}

function isExcludedDirectory(name) {
  return name.startsWith('.') || EXCLUDED_DIRECTORY_NAMES.has(name)
}

function collectScripts(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const entryPath = path.join(directory, entry.name)
    if (entry.isDirectory()) {
      return isExcludedDirectory(entry.name) ? [] : collectScripts(entryPath)
    }
    return entry.isFile() && isScript(entry.name) ? [entryPath] : []
  })
}

function installBundler() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bundler-requires-'))
  fs.writeFileSync(
    path.join(root, 'package.json'),
    JSON.stringify({ name: 'bundler-requires', private: true, overrides: LEXER_OVERRIDES })
  )
  const result = spawnSync(
    'npm',
    ['install', '--no-save', '--no-audit', '--no-fund', '--prefix', root, BUNDLER_SPEC],
    { encoding: 'utf8' }
  )
  if (result.status !== 0) {
    throw new Error(`failed to install ${BUNDLER_SPEC}: ${result.stderr || result.stdout}`)
  }
  return path.join(root, 'node_modules', 'bare-pack', 'package.json')
}

function loadLexer() {
  const bundlerManifest = installBundler()
  const lexerPath = createRequire(bundlerManifest).resolve(LEXER_PACKAGE)
  const lexer = createRequire(import.meta.url)(lexerPath)
  const version = JSON.parse(
    fs.readFileSync(path.join(path.dirname(lexerPath), 'package.json'), 'utf8')
  ).version
  process.stdout.write(`Using ${LEXER_PACKAGE}@${version} as resolved by ${BUNDLER_SPEC}.\n`)
  return lexer
}

function writtenSpecifiers(source) {
  return [...source.matchAll(REQUIRE_PATTERN)].map((match) => match[1])
}

function relativeOnly(specifiers) {
  return new Set(specifiers.filter((specifier) => specifier.startsWith('.')))
}

function lexedSpecifiers(lex, source) {
  return lex(Buffer.from(source)).imports.map((entry) => entry.specifier)
}

function hiddenSpecifiers(lex, scriptPath) {
  const source = fs.readFileSync(scriptPath, 'utf8')
  const lexed = relativeOnly(lexedSpecifiers(lex, source))
  return [...relativeOnly(writtenSpecifiers(source))].filter((specifier) => !lexed.has(specifier))
}

function reportHidden(directory, scriptPath, specifiers) {
  const relativePath = path.relative(directory, scriptPath)
  for (const specifier of specifiers) {
    process.stderr.write(
      `::error file=${relativePath}::require('${specifier}') is invisible to bare-module-lexer, ` +
        'so bare-pack will leave it out of the mobile app bundle\n'
    )
  }
}

function countHidden(lex, directory, scripts) {
  let hidden = 0
  for (const scriptPath of scripts) {
    const specifiers = hiddenSpecifiers(lex, scriptPath)
    if (specifiers.length === 0) continue
    reportHidden(directory, scriptPath, specifiers)
    hidden += specifiers.length
  }
  return hidden
}

function checkPackage() {
  const directory = packageDirectory()
  if (!fs.existsSync(path.join(directory, 'package.json'))) {
    throw new Error(`no package.json in ${directory}`)
  }
  const lex = loadLexer()
  const scripts = collectScripts(directory)
  const hidden = countHidden(lex, directory, scripts)
  process.stdout.write(
    `Checked ${scripts.length} script(s) in ${path.basename(directory)}: ` +
      `${hidden} require(s) hidden from the bundler.\n`
  )
  return hidden === 0 ? 0 : EXIT_HIDDEN_REQUIRE
}

// Exit codes: 0 = clean, 1 = a require is hidden from the bundler,
// 2 = the check itself could not run (install/lexer/package resolution) —
// callers must not report an infrastructure failure as a bundler omission.
function main() {
  try {
    process.exit(checkPackage())
  } catch (error) {
    process.stderr.write(`::error::check-bundler-requires could not run: ${error.message}\n`)
    process.exit(EXIT_INFRASTRUCTURE)
  }
}

main()
