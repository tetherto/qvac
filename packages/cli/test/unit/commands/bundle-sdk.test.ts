import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { Command, CommanderError } from 'commander'
import { registerBundleCommand } from '@/bundle-sdk/command'
import { BundleOptionsError, iosEngineFor } from '@/bundle-sdk/options'

describe('bundle sdk --ios-engine', () => {
  it('passes the engine to a react-native bundle', () => {
    assert.equal(iosEngineFor('react-native', 'v8'), 'v8')
    assert.equal(iosEngineFor('react-native', 'javascriptcore'), 'javascriptcore')
  })

  it('leaves the engine to the SDK default without the flag', () => {
    assert.equal(iosEngineFor('react-native', undefined), undefined)
    assert.equal(iosEngineFor('bare-sidecar', undefined), undefined)
  })

  it('refuses the flag for a target that has no iOS worker', () => {
    for (const target of ['bare-sidecar', 'pear-runtime']) {
      assert.throws(
        () => iosEngineFor(target, 'v8'),
        (error: unknown) =>
          error instanceof BundleOptionsError &&
          error.option === '--ios-engine' &&
          error.message.includes(target)
      )
    }
  })

  it('rejects an engine Bare Kit cannot run', async () => {
    const program = new Command().exitOverride().configureOutput({ writeErr: () => {} })
    registerBundleCommand(program)

    await assert.rejects(
      program.parseAsync(['bundle', 'sdk', '--ios-engine', 'hermes'], { from: 'user' }),
      (error: unknown) =>
        error instanceof CommanderError && error.code === 'commander.invalidArgument'
    )
  })
})
