import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { parseBareKitPins } from '@/commands/verify/bare-kit-runtime'

const SDK_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const SWIFT_PACKAGE_SWIFT = path.resolve(SDK_DIR, '..', 'sdk-swift', 'Package.swift')

function bareStowSwiftPin(): string | null {
  const bareStowDir = path.dirname(
    createRequire(path.join(SDK_DIR, 'package.json')).resolve('bare-stow/package')
  )
  const target = fs.readFileSync(path.join(bareStowDir, 'lib', 'target', 'bare-kit.js'), 'utf8')
  return parseBareKitPins(target).ios
}

function packageSwiftPin(): string | null {
  const manifest = fs.readFileSync(SWIFT_PACKAGE_SWIFT, 'utf8')
  const match =
    /"https:\/\/github\.com\/holepunchto\/bare-kit-swift(?:\.git)?"\s*,\s*exact:\s*"(\d+\.\d+\.\d+[^"\s]*)"/.exec(
      manifest
    )
  return match?.[1] ?? null
}

describe('bare-kit-swift pin', () => {
  it("matches in the Swift SDK's Package.swift and the bare-stow the SDK bundles with", () => {
    const bareStow = bareStowSwiftPin()
    const packageSwift = packageSwiftPin()
    assert.ok(bareStow, 'bare-stow pins no bare-kit-swift version')
    assert.ok(packageSwift, 'Package.swift has no exact bare-kit-swift pin')
    assert.equal(
      packageSwift,
      bareStow,
      `Package.swift pins bare-kit-swift ${packageSwift}, bare-stow writes ${bareStow}`
    )
  })
})
