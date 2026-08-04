import test from 'brittle'
import { readFile } from 'node:fs/promises'

test('harness exports only package-owned lifecycle surfaces', async (t) => {
  const manifest = await readManifest()
  t.alike(Object.keys(manifest.exports).sort(), [
    '.',
    './expo-plugin',
    './package',
    './react-native'
  ])
  t.alike(manifest.exports['.'], {
    'react-native': './react-native.ts',
    default: './index.ts'
  })
})

test('harness ships worker artifacts without exporting them', async (t) => {
  const manifest = await readManifest()
  const files = manifest.files
  for (const file of [
    'child-entry.ts',
    'mobile-entry.ts',
    'tool-sandbox-child-entry.ts',
    'schema/**/*',
    'spec/**/*',
    'skills/**/*'
  ]) {
    t.ok(files.includes(file), `${file} is packaged`)
  }
})

async function readManifest() {
  return JSON.parse(
    await readFile(new URL('../package.json', import.meta.url), 'utf8')
  ) as {
    readonly exports: Readonly<Record<string, unknown>>
    readonly files: readonly string[]
  }
}
