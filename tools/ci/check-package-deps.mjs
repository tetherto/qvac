#!/usr/bin/env node
/**
 * Validates package.json dependency versions for CI sanity checks.
 * Mirrors the jq/grep logic previously inlined in sanity-checks action.yaml.
 */
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const packageJsonPath = resolve(process.cwd(), 'package.json')
const pkg = JSON.parse(readFileSync(packageJsonPath, 'utf8'))

const sections = [pkg.dependencies, pkg.devDependencies].filter(Boolean)
const values = sections.flatMap((section) => Object.values(section))

const disallowed = /^(git\+https:\/\/github.com|[0-9]+\.[0-9]+\.[0-9]+-(dev|tmp)[^"]*)$/

for (const value of values) {
  if (typeof value === 'string' && disallowed.test(value)) {
    console.error(
      '::error title=Disallowed dependency detected::Do not use git URLs or dev/tmp versions in dependencies'
    )
    console.error(`Found: ${value}`)
    process.exit(1)
  }
}

console.log('Dependency versions OK')
