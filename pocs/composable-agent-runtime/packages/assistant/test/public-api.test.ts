import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'

describe('assistant public API', () => {
  it('exports only application lifecycle entrypoints', async () => {
    const manifest = JSON.parse(
      await readFile(new URL('../package.json', import.meta.url), 'utf8')
    )
    expect(Object.keys(manifest.exports).sort()).toEqual([
      '.',
      './expo-plugin',
      './package',
      './react-native'
    ])
    expect(manifest.exports['.']).toEqual({
      'react-native': './react-native.ts',
      default: './index.ts'
    })
  })
})
