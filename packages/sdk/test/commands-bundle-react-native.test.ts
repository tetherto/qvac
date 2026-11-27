import test from 'brittle'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import stow from 'bare-stow'
import reactNative from 'bare-stow-target-react-native'
import { reactNativeTargetOptions } from '@/commands/bundle/index'
import { readBundle } from '@/commands/bundle/read-bundle'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const PHONES = ['ios-arm64', 'android-arm64']

function writeFile(file: string, content: string) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, content)
}

test('reactNativeTargetOptions: converts the bundle only when iOS runs on JavaScriptCore', (t) => {
  const javascriptcore = { ios: { engine: 'javascriptcore' } }

  t.alike(reactNativeTargetOptions('react-native', undefined, PHONES), javascriptcore, 'by default')
  t.alike(reactNativeTargetOptions('react-native', 'javascriptcore', ['ios-arm64']), javascriptcore)
  t.is(reactNativeTargetOptions('react-native', 'v8', PHONES), undefined)
  t.is(reactNativeTargetOptions('react-native', undefined, ['android-arm64']), undefined)
  t.is(reactNativeTargetOptions('bare-kit', undefined, ['ios-arm64']), undefined)
})

test('a React Native bundle for JavaScriptCore holds no ES module syntax', async (t) => {
  t.timeout(60_000)
  const dir = createProject(t)

  writeFile(
    path.join(dir, 'node_modules', 'cjs-pkg', 'package.json'),
    '{"name":"cjs-pkg","main":"index.js"}'
  )
  writeFile(
    path.join(dir, 'node_modules', 'cjs-pkg', 'index.js'),
    "exports.lazy = () => import('./lazy.js')\n"
  )
  writeFile(path.join(dir, 'node_modules', 'cjs-pkg', 'lazy.js'), "module.exports = 'lazy'\n")
  // Exported only for import, as the SDK's own subpaths are.
  writeFile(
    path.join(dir, 'node_modules', 'esm-pkg', 'package.json'),
    JSON.stringify({ name: 'esm-pkg', type: 'module', exports: { import: './index.js' } })
  )
  writeFile(
    path.join(dir, 'node_modules', 'esm-pkg', 'index.js'),
    "export const value = 'esm'\nexport const url = import.meta.url\n"
  )
  const entry = path.join(dir, 'app', 'entry.mjs')
  writeFile(
    entry,
    "import { lazy } from 'cjs-pkg'\nimport { value } from 'esm-pkg'\n" +
      'export default async function start() {\n  return [value, await lazy()]\n}\n'
  )

  const esm = await stowReactNative(entry, path.join(dir, 'v8'), undefined)
  t.ok(
    esm.some(({ source }) => /^export default/m.test(source)),
    'with V8 on both phones, the modules stay ES modules'
  )

  const modules = await stowReactNative(
    entry,
    path.join(dir, 'javascriptcore'),
    reactNativeTargetOptions('react-native', undefined, PHONES)
  )
  t.is(modules.length, esm.length, 'the converted bundle holds the same modules')
  for (const { file, source } of modules) {
    t.absent(/^\s*(import|export)\b(?!\s*\()/m.test(source), `${file} has no import or export`)
    t.absent(/\bimport\s*\(/.test(source), `${file} has no import()`)
    t.absent(/\bimport\.meta\b/.test(source), `${file} has no import.meta`)
  }
})

test('a top-level await fails a React Native bundle for JavaScriptCore, naming the module', async (t) => {
  t.timeout(60_000)
  const dir = createProject(t)
  const entry = path.join(dir, 'app', 'entry.mjs')
  writeFile(entry, 'await null\nexport default function start() {}\n')

  await t.execution(stowReactNative(entry, path.join(dir, 'v8'), undefined), 'V8 runs it')
  // bare-bundle-lower reports it as a SyntaxError.
  await t.exception.all(
    stowReactNative(
      entry,
      path.join(dir, 'javascriptcore'),
      reactNativeTargetOptions('react-native', undefined, PHONES)
    ),
    /Top-level await cannot be lowered to CommonJS at file:\/\/.*\/app\/entry\.mjs/
  )
})

function createProject(t: { teardown: (fn: () => void) => void }) {
  const dir = fs.mkdtempSync(path.join(__dirname, 'tmp-react-native-bundle-'))
  t.teardown(() => fs.rmSync(dir, { recursive: true, force: true }))
  return dir
}

/** The script modules of the bundle the React Native target writes, uncompressed to read them. */
async function stowReactNative(
  entry: string,
  outDir: string,
  targetOptions: stow.TargetOptions | undefined
) {
  let bundlePath: string | undefined
  for await (const artifact of stow(
    pathToFileURL(entry).href,
    reactNative,
    pathToFileURL(outDir).href,
    { hosts: PHONES, compress: false, ...(targetOptions !== undefined && { targetOptions }) }
  )) {
    if (artifact.base !== undefined) bundlePath = fileURLToPath(artifact.url.href)
  }
  const bundle = await readBundle(bundlePath!)
  return Object.keys(bundle.files)
    .filter((file) => /\.[cm]?js$/.test(file))
    .map((file) => ({ file, source: bundle.read(file)!.toString() }))
}
