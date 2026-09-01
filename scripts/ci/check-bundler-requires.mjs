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
const REQUIRE_PATTERN = /require\(\s*['"]([^'"]+)['"]\s*\)/g
// Only the runtime graph a mobile bundle pulls in. Generators under `scripts/`
// and fixtures under `test/` embed require-looking strings in their output, and
// none of them are ever bundled.
const RUNTIME_DIRECTORIES = ['.', 'lib']

function packageDirectory() {
  return path.resolve(process.argv[2] ?? '.')
}

function isScript(name) {
  return name.endsWith('.js') || name.endsWith('.cjs')
}

function scriptsIn(directory) {
  if (!fs.existsSync(directory)) return []
  return fs
    .readdirSync(directory, { withFileTypes: true })
    .filter((entry) => entry.isFile() && isScript(entry.name))
    .map((entry) => path.join(directory, entry.name))
}

function collectScripts(packageRoot) {
  return RUNTIME_DIRECTORIES.flatMap((directory) => scriptsIn(path.join(packageRoot, directory)))
}

function installBundler() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bundler-requires-'))
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

function main() {
  const directory = packageDirectory()
  if (!fs.existsSync(path.join(directory, 'package.json'))) {
    process.stderr.write(`no package.json in ${directory}\n`)
    process.exit(1)
  }
  const lex = loadLexer()
  const scripts = collectScripts(directory)
  let hidden = 0
  for (const scriptPath of scripts) {
    const specifiers = hiddenSpecifiers(lex, scriptPath)
    if (specifiers.length === 0) continue
    reportHidden(directory, scriptPath, specifiers)
    hidden += specifiers.length
  }
  process.stdout.write(
    `Checked ${scripts.length} script(s) in ${path.basename(directory)}: ` +
      `${hidden} require(s) hidden from the bundler.\n`
  )
  process.exit(hidden === 0 ? 0 : 1)
}

main()
