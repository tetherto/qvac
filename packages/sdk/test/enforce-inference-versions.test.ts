import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  checkAddonRanges,
  checkSharedMajorMinor,
  collectVersionFailures,
  isLocalSpec,
  type Manifest
} from '../scripts/enforce-inference-versions'

function sdkManifest(
  version: string,
  range: string,
  addons: Record<string, string> = {}
): Manifest {
  return {
    version,
    dependencies: { '@qvac/inference': range, ...addons }
  }
}

function inferenceManifest(addons: Record<string, string> = {}): Manifest {
  return {
    peerDependencies: { ...addons },
    devDependencies: { ...addons }
  }
}

// Every spec the release and e2e tooling can write in place of a published
// range. The tarball forms come from
// .github/actions/sdk-e2e-prepare-inference/prepare.mjs, which writes a file:
// URL everywhere except win32 and a bare drive path there.
const localSpecs = [
  'file:../inference',
  'link:../inference',
  'npm:@tetherto/inference-mono@1.2.3',
  'file:///Users/runner/work/_temp/sdk-e2e-inference/1-1/qvac-inference-0.19.1.tgz',
  'C:/actions-runner-2/_work/_temp/sdk-e2e-inference/1-1/qvac-inference-0.19.1.tgz',
  'C:\\actions-runner-2\\_work\\_temp\\qvac-inference-0.19.1.tgz',
  '/tmp/sdk-e2e/inference/qvac-inference-0.19.1.tgz',
  './.sdk-e2e/inference/qvac-inference-0.19.1.tgz',
  '../inference/qvac-inference-0.19.1.tgz'
]

// Ranges the check must keep reading. Skipping one would let a real version
// drift through unreported.
const publishedRanges = [
  '^0.19.0',
  '~0.19.0',
  '^1.19.0',
  '0.19.0',
  '^0.19.x',
  '>=0.19.0 <0.20.0',
  '*'
]

describe('isLocalSpec', () => {
  for (const spec of localSpecs) {
    it(`treats "${spec}" as local`, () => {
      assert.equal(isLocalSpec(spec), true)
    })
  }

  for (const range of publishedRanges) {
    it(`leaves "${range}" for the major.minor check`, () => {
      assert.equal(isLocalSpec(range), false)
    })
  }
})

describe('checkSharedMajorMinor', () => {
  it('accepts a range on the SDK major.minor', () => {
    assert.deepEqual(checkSharedMajorMinor(sdkManifest('0.19.0', '^0.19.0')), [])
  })

  it('accepts patches moving independently on either side', () => {
    assert.deepEqual(checkSharedMajorMinor(sdkManifest('0.19.4', '^0.19.2')), [])
    assert.deepEqual(checkSharedMajorMinor(sdkManifest('0.19.0', '^0.19.7')), [])
  })

  it('rejects a range behind the SDK version', () => {
    const [failure] = checkSharedMajorMinor(sdkManifest('0.20.0', '^0.19.0'))
    assert.match(failure, /must share a major\.minor/)
  })

  it('rejects an SDK version behind the range', () => {
    const [failure] = checkSharedMajorMinor(sdkManifest('0.19.0', '^0.20.0'))
    assert.match(failure, /must share a major\.minor/)
  })

  it('rejects a major mismatch', () => {
    const [failure] = checkSharedMajorMinor(sdkManifest('1.19.0', '~0.19.0'))
    assert.match(failure, /must share a major\.minor/)
  })

  it('rejects a caret from 1.0.0 up, where it reaches the next minor', () => {
    const [failure] = checkSharedMajorMinor(sdkManifest('1.19.0', '^1.19.0'))
    assert.match(failure, /Use "~1\.19\.0"/)
  })

  it('accepts a tilde from 1.0.0 up', () => {
    assert.deepEqual(checkSharedMajorMinor(sdkManifest('1.19.0', '~1.19.0')), [])
  })

  it('accepts a tilde below 1.0.0', () => {
    assert.deepEqual(checkSharedMajorMinor(sdkManifest('0.19.0', '~0.19.0')), [])
  })

  for (const range of ['0.19.0', '^0.19.x', '>=0.19.0 <0.20.0', '*']) {
    it(`rejects "${range}", which pins no single major.minor`, () => {
      const [failure] = checkSharedMajorMinor(sdkManifest('0.19.0', range))
      assert.match(failure, /one caret or tilde range over an exact version/)
    })
  }

  for (const spec of localSpecs) {
    it(`skips "${spec}", which names no published version`, () => {
      assert.deepEqual(checkSharedMajorMinor(sdkManifest('0.19.0', spec)), [])
    })
  }

  it('rejects an SDK version that is not plain x.y.z', () => {
    const [failure] = checkSharedMajorMinor(sdkManifest('0.19.0-rc.1', '^0.19.0'))
    assert.match(failure, /is not a plain x\.y\.z version/)
  })

  it('reports a manifest with no version', () => {
    const [failure] = checkSharedMajorMinor({ dependencies: { '@qvac/inference': '^0.19.0' } })
    assert.match(failure, /declares no version/)
  })

  it('reports a manifest with no @qvac/inference dependency', () => {
    const [failure] = checkSharedMajorMinor({ version: '0.19.0' })
    assert.match(failure, /declares no @qvac\/inference dependency/)
  })
})

describe('checkAddonRanges', () => {
  it('accepts addon ranges identical across all three lists', () => {
    assert.deepEqual(
      checkAddonRanges(
        inferenceManifest({ '@qvac/llm-llamacpp': '^1.2.3' }),
        sdkManifest('0.19.0', '^0.19.0', { '@qvac/llm-llamacpp': '^1.2.3' })
      ),
      []
    )
  })

  it('reports an addon range the SDK has drifted on', () => {
    const [failure] = checkAddonRanges(
      inferenceManifest({ '@qvac/llm-llamacpp': '^1.2.3' }),
      sdkManifest('0.19.0', '^0.19.0', { '@qvac/llm-llamacpp': '^1.2.4' })
    )
    assert.match(failure, /SDK has \^1\.2\.4/)
  })

  it('reports an addon the SDK is missing', () => {
    const [failure] = checkAddonRanges(
      inferenceManifest({ '@qvac/llm-llamacpp': '^1.2.3' }),
      sdkManifest('0.19.0', '^0.19.0')
    )
    assert.match(failure, /SDK is missing it/)
  })

  it('reports an addon missing from inference devDependencies', () => {
    const [failure] = checkAddonRanges(
      { peerDependencies: { '@qvac/llm-llamacpp': '^1.2.3' }, devDependencies: {} },
      sdkManifest('0.19.0', '^0.19.0', { '@qvac/llm-llamacpp': '^1.2.3' })
    )
    assert.match(failure, /inference devDependencies is missing it/)
  })
})

describe('collectVersionFailures', () => {
  it('passes a manifest pair that satisfies both rules', () => {
    assert.deepEqual(
      collectVersionFailures(
        inferenceManifest({ '@qvac/llm-llamacpp': '^1.2.3' }),
        sdkManifest('0.19.0', '^0.19.0', { '@qvac/llm-llamacpp': '^1.2.3' })
      ),
      []
    )
  })

  it('reports both rules in one run', () => {
    const failures = collectVersionFailures(
      inferenceManifest({ '@qvac/llm-llamacpp': '^1.2.3' }),
      sdkManifest('0.20.0', '^0.19.0', { '@qvac/llm-llamacpp': '^1.2.4' })
    )
    assert.equal(failures.length, 2)
    assert.match(failures[0], /SDK has \^1\.2\.4/)
    assert.match(failures[1], /must share a major\.minor/)
  })
})
