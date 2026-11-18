import type { Step, TestDefinition } from '@qvac/test-suite'

// A source or name that would resolve outside the cache must be refused before
// anything is fetched or written. Every case is rejected before any request, so
// the HTTP sources point at a closed loopback port: no server and no model are
// needed, and the same body runs on every leg.
//
// The backslash cases escape on Windows only, where `\` separates paths; the
// other legs run them so the refusal stays the same on every OS.

const CLOSED_PORT = 'http://127.0.0.1:9'
const HYPERDRIVE_KEY = 'a'.repeat(64)

/** One call that must fail; the expectation reads its message. */
const rejects = (method: string, params: Record<string, unknown>): Step[] => [
  { callError: { method, params, as: 'err' } },
  { project: { from: '$err', path: 'message', as: 'message' } },
  { assert: { on: '$message', use: 'expectation' } }
]

const loadModelRejects = rejects('loadModel', {
  modelSrc: '$params.modelSrc',
  modelType: '$params.modelType'
})

const downloadAssetRejects = rejects('downloadAsset', { assetSrc: '$params.assetSrc' })

const metadata = { category: 'path-security', dependency: 'none', estimatedDurationMs: 5000 }

export const pathTraversalHttpShardedLoad: TestDefinition = {
  testId: 'path-traversal-http-sharded-load',
  params: {
    modelSrc: `${CLOSED_PORT}/models/..\\..\\escape-00001-of-00002.gguf`,
    modelType: 'llamacpp-completion'
  },
  expectation: { validation: 'throws-error', errorContains: 'Path traversal detected' },
  steps: loadModelRejects,
  metadata
}

// The `/` inside the query makes the shard name the part after it, while the
// request itself goes to the file in the path.
export const pathTraversalHttpShardedQuery: TestDefinition = {
  testId: 'path-traversal-http-sharded-query',
  params: {
    assetSrc: `${CLOSED_PORT}/models/model-00001-of-00001.gguf?download=/..\\..\\escape-00001-of-00001.gguf`
  },
  expectation: { validation: 'throws-error', errorContains: 'Path traversal detected' },
  steps: downloadAssetRejects,
  metadata
}

// The request drops the fragment, so only the shard name carries the traversal.
export const pathTraversalHttpShardedFragment: TestDefinition = {
  testId: 'path-traversal-http-sharded-fragment',
  params: {
    assetSrc: `${CLOSED_PORT}/models/model-00001-of-00001.gguf#..\\..\\escape-00001-of-00001.gguf`
  },
  expectation: { validation: 'throws-error', errorContains: 'Path traversal detected' },
  steps: downloadAssetRejects,
  metadata
}

// `..` inside a name is not a segment: the download must get past the path
// check and fail only on the closed port.
export const pathTraversalHttpShardedDottedName: TestDefinition = {
  testId: 'path-traversal-http-sharded-dotted-name',
  params: { assetSrc: `${CLOSED_PORT}/models/model..v2-00001-of-00001.gguf` },
  expectation: { validation: 'throws-error', errorContains: 'Connection failed' },
  steps: downloadAssetRejects,
  metadata: { ...metadata, estimatedDurationMs: 15000 }
}

// Refused before any Corestore or swarm is set up, so the key needs no drive.
export const pathTraversalHyperdriveLoad: TestDefinition = {
  testId: 'path-traversal-hyperdrive-load',
  params: {
    modelSrc: `pear://${HYPERDRIVE_KEY}/models/../../../escape.gguf`,
    modelType: 'llamacpp-completion'
  },
  expectation: { validation: 'throws-error', errorContains: 'Path traversal detected' },
  steps: loadModelRejects,
  metadata
}

// The check must split on both separators: on Windows a `..\` drive path
// escapes the cache like `../` does.
export const pathTraversalHyperdriveBackslashLoad: TestDefinition = {
  testId: 'path-traversal-hyperdrive-backslash-load',
  params: {
    modelSrc: `pear://${HYPERDRIVE_KEY}/models/..\\..\\..\\escape.gguf`,
    modelType: 'llamacpp-completion'
  },
  expectation: { validation: 'throws-error', errorContains: 'Path traversal detected' },
  steps: loadModelRejects,
  metadata
}

// Deleting a workspace removes its directory; the name must not reach a sibling.
// The target does not exist, so a regression deletes nothing.
export const pathTraversalRagDeleteWorkspace: TestDefinition = {
  testId: 'path-traversal-rag-delete-workspace',
  params: { workspace: '../path-traversal-e2e-canary' },
  expectation: { validation: 'throws-error', errorContains: 'traversal' },
  steps: rejects('ragDeleteWorkspace', { workspace: '$params.workspace' }),
  metadata
}

export const pathTraversalTests = [
  pathTraversalHttpShardedLoad,
  pathTraversalHttpShardedQuery,
  pathTraversalHttpShardedFragment,
  pathTraversalHttpShardedDottedName,
  pathTraversalHyperdriveLoad,
  pathTraversalHyperdriveBackslashLoad,
  pathTraversalRagDeleteWorkspace
]
