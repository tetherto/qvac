import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const SRC = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'src')
const CORE = join(SRC, 'serve', 'core')

function sourceFiles(dir: string): string[] {
  const found: string[] = []
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) found.push(...sourceFiles(full))
    else if (full.endsWith('.ts')) found.push(full)
  }
  return found
}

describe('serve layering', () => {
  it('core does not import from any extension', () => {
    const offenders = sourceFiles(CORE)
      .filter((file) => readFileSync(file, 'utf8').includes('@/serve/extensions'))
      .map((file) => relative(SRC, file))

    assert.deepEqual(
      offenders,
      [],
      'serve/core must stay shape-agnostic; move the shared piece out of the extension instead'
    )
  })

  it('finds the core sources it claims to check', () => {
    assert.ok(sourceFiles(CORE).length > 5)
  })
})
