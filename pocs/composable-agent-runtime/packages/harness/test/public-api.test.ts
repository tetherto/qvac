import test from 'brittle'
import { readFile } from 'node:fs/promises'

// Worker *entries* stay private; worker *authoring kits* are exported, because
// once applications own skills they are worker-entry authors by definition.
// Kept on their own subpaths so the sandbox transport and worker plumbing never
// reach the root graph a plain client process imports.
test('harness exports lifecycle surfaces and skill authoring kits', async (t) => {
  const manifest = await readManifest()
  t.alike(Object.keys(manifest.exports).sort(), [
    '.',
    './expo-plugin',
    './package',
    './react-native',
    './skill-host',
    './skill-sandbox'
  ])
  t.alike(manifest.exports['.'], {
    'react-native': './react-native.ts',
    default: './index.ts'
  })
})

test('harness ships worker artifacts without exporting them', async (t) => {
  const manifest = await readManifest()
  const files = manifest.files
  for (const file of ['child-entry.ts', 'mobile-entry.ts', 'schema/**/*', 'spec/**/*']) {
    t.ok(files.includes(file), `${file} is packaged`)
  }
  // Skills belong to applications now, so Harness ships none.
  t.absent(files.includes('skills/**/*'), 'harness packages no skills')
})

async function readManifest() {
  return JSON.parse(
    await readFile(new URL('../package.json', import.meta.url), 'utf8')
  ) as {
    readonly exports: Readonly<Record<string, unknown>>
    readonly files: readonly string[]
  }
}
