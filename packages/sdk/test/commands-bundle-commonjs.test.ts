import test from 'brittle'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import Bundle from 'bare-bundle'
import stow from 'bare-stow'
import { commonJSStowOptions, convertToCommonJS } from '@/commands/bundle/commonjs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const MODULE_URL = new URL('file:///app/index.js')

function writeFile(file: string, content: string) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, content)
}

test('convertToCommonJS: rewrites imports, exports and import() as CommonJS', async (t) => {
  const code = await convertToCommonJS(
    MODULE_URL,
    "import a from 'a'\nexport const b = a\nexport default async () => import('./c.js')\n"
  )

  t.ok(code.startsWith("'use strict';"), 'the converted module stays strict')
  t.ok(code.includes('require("a")'))
  t.ok(code.includes('require("./c.js")'))
  t.absent(/\bimport\s*\(/.test(code), 'no import() is left for JavaScriptCore')
  t.absent(/^\s*(import|export)\s/m.test(code), 'no import or export statement is left')
})

test('convertToCommonJS: rejects a top-level await, naming the module', async (t) => {
  await t.exception(
    convertToCommonJS(MODULE_URL, "export const a = await import('a')\n"),
    /file:\/\/\/app\/index\.js to CommonJS for JavaScriptCore: Top-level await/
  )
})

test('convertToCommonJS: rejects import.meta, which CommonJS has no equivalent of', async (t) => {
  await t.exception(
    convertToCommonJS(MODULE_URL, 'export const url = import.meta.url\n'),
    /file:\/\/\/app\/index\.js to CommonJS for JavaScriptCore: it reads import\.meta/
  )
})

test('commonJSStowOptions: reads a missing module as null', async (t) => {
  const { readModule } = commonJSStowOptions()

  t.is(await readModule!(new URL('file:///qvac-missing/index.js')), null)
})

test('commonJSStowOptions: stows a graph without ES modules that runs as its ES modules do', async (t) => {
  t.timeout(60_000)
  const dir = fs.mkdtempSync(path.join(__dirname, 'tmp-commonjs-bundle-'))
  t.teardown(() => fs.rmSync(dir, { recursive: true, force: true }))

  const cjsSource = "module.exports = { value: 'cjs' }\n"
  writeFile(path.join(dir, 'node_modules', 'cjs-pkg', 'package.json'), '{"name":"cjs-pkg"}')
  writeFile(path.join(dir, 'node_modules', 'cjs-pkg', 'index.js'), cjsSource)
  // Exported only for import, as the SDK's own subpaths are.
  writeFile(
    path.join(dir, 'node_modules', 'esm-pkg', 'package.json'),
    JSON.stringify({ name: 'esm-pkg', type: 'module', exports: { import: './index.js' } })
  )
  writeFile(
    path.join(dir, 'node_modules', 'esm-pkg', 'index.js'),
    "export const value = 'esm'\nexport const lazy = () => import('./lazy.js')\n"
  )
  writeFile(path.join(dir, 'node_modules', 'esm-pkg', 'lazy.js'), "export default 'lazy'\n")
  // Compiled from TypeScript: Bare imports its `default` export as the default.
  writeFile(path.join(dir, 'node_modules', 'flagged-pkg', 'package.json'), '{"name":"flagged-pkg"}')
  writeFile(
    path.join(dir, 'node_modules', 'flagged-pkg', 'index.js'),
    "Object.defineProperty(exports, '__esModule', { value: true })\nexports.default = 'inner'\n"
  )
  writeFile(
    path.join(dir, 'app', 'entry.mjs'),
    `import cjs from 'cjs-pkg'
import flagged from 'flagged-pkg'
import { value, lazy } from 'esm-pkg'

function receiver() {
  return this
}

export default async function start(ipc, ready) {
  const loaded = await lazy()
  if (cjs.value !== 'cjs' || value !== 'esm' || loaded.default !== 'lazy') {
    throw new Error('the converted graph lost a binding')
  }
  if (flagged !== 'inner') throw new Error('a compiled CommonJS default is not its default export')
  if (receiver() !== undefined) throw new Error('the converted entry is not strict')
  ready()
}
`
  )

  // The entry's checks hold as Bare runs its ES modules, and so for the
  // converted graph too.
  const entry = pathToFileURL(path.join(dir, 'app', 'entry.mjs')).href
  t.is(await startWorker(await stowWorker(entry, path.join(dir, 'esm'))), 0, 'the ES modules run')

  const outDir = path.join(dir, 'commonjs')
  const bundle = Bundle.from(
    fs.readFileSync(await stowWorker(entry, outDir, commonJSStowOptions()))
  )
  const scripts = Object.keys(bundle.files).filter((file) => /\.[cm]?js$/.test(file))
  t.ok(scripts.length > 0)
  t.alike(
    scripts.filter((file) => !file.endsWith('.cjs')),
    [],
    'every module loads as CommonJS'
  )
  for (const file of scripts) {
    const source = bundle.read(file)!.toString()
    t.absent(/^\s*(import|export)\s/m.test(source), `${file} holds no ES module syntax`)
  }
  const cjsFile = scripts.find((file) => file.endsWith('/cjs-pkg/index.cjs'))
  t.is(bundle.read(cjsFile!)!.toString(), cjsSource, 'a CommonJS module is left as it is')

  t.is(await startWorker(outDir), 0, 'the converted modules run')
})

async function stowWorker(entry: string, outDir: string, options: stow.StowOptions = {}) {
  let bundlePath: string | undefined
  for await (const artifact of stow(entry, 'bare-sidecar', pathToFileURL(outDir).href, {
    hosts: [`${process.platform}-${process.arch}`],
    ...options
  })) {
    if (artifact.base !== undefined) bundlePath = fileURLToPath(artifact.url.href)
  }
  return bundlePath!
}

/** Starts the worker through its harness, and returns its exit code once stopped. */
async function startWorker(bundlePathOrDir: string) {
  const dir = bundlePathOrDir.endsWith('.bundle') ? path.dirname(bundlePathOrDir) : bundlePathOrDir
  const harness = (await import(pathToFileURL(path.join(dir, 'index.js')).href)) as {
    start(): Promise<{ ipc: { terminate(): Promise<number> } }>
  }
  const { ipc } = await harness.start()
  return ipc.terminate()
}
