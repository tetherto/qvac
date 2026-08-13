import test from 'brittle'
import fs from 'bare-fs'

// Unit tests run with the package root as the working directory.
test('error metadata version matches package.json', (t) => {
  const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8')) as { version: string }
  const source = fs.readFileSync('src/errors.ts', 'utf8')

  const match = source.match(/version:\s*'([^']+)'/)
  t.ok(match, 'errors.ts should declare a version literal')
  t.is(match?.[1], pkg.version, 'errors.ts version must match package.json version')
})
