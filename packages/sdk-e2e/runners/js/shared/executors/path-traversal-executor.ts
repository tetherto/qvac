import { downloadAsset, loadModel, ragDeleteWorkspace } from '@qvac/sdk'
import {
  BaseExecutor,
  ValidationHelpers,
  type Expectation,
  type TestResult
} from '@qvac/test-suite'
import {
  pathTraversalHttpShardedLoad,
  pathTraversalHttpShardedQuery,
  pathTraversalHttpShardedFragment,
  pathTraversalHttpShardedDottedName,
  pathTraversalHyperdriveLoad,
  pathTraversalHyperdriveBackslashLoad,
  pathTraversalRagDeleteWorkspace
} from '../../../../catalog/path-traversal-tests.js'

const pathTraversalTests = [
  pathTraversalHttpShardedLoad,
  pathTraversalHttpShardedQuery,
  pathTraversalHttpShardedFragment,
  pathTraversalHttpShardedDottedName,
  pathTraversalHyperdriveLoad,
  pathTraversalHyperdriveBackslashLoad,
  pathTraversalRagDeleteWorkspace
] as const

interface LoadParams {
  modelSrc: string
  modelType: string
}

interface DownloadParams {
  assetSrc: string
}

interface WorkspaceParams {
  workspace: string
}

// The same bodies as the definitions' steps, for the React Native consumer,
// which has no step interpreter.
export class PathTraversalExecutor extends BaseExecutor<typeof pathTraversalTests> {
  pattern = /^path-traversal-/

  protected handlers = {
    [pathTraversalHttpShardedLoad.testId]: this.loadRejects.bind(this),
    [pathTraversalHttpShardedQuery.testId]: this.downloadRejects.bind(this),
    [pathTraversalHttpShardedFragment.testId]: this.downloadRejects.bind(this),
    [pathTraversalHttpShardedDottedName.testId]: this.downloadRejects.bind(this),
    [pathTraversalHyperdriveLoad.testId]: this.loadRejects.bind(this),
    [pathTraversalHyperdriveBackslashLoad.testId]: this.loadRejects.bind(this),
    [pathTraversalRagDeleteWorkspace.testId]: this.deleteWorkspaceRejects.bind(this)
  }

  async loadRejects(params: LoadParams, expectation: Expectation): Promise<TestResult> {
    return rejection(
      () => loadModel({ modelSrc: params.modelSrc, modelType: params.modelType } as never),
      expectation
    )
  }

  async downloadRejects(params: DownloadParams, expectation: Expectation): Promise<TestResult> {
    return rejection(() => downloadAsset({ assetSrc: params.assetSrc }), expectation)
  }

  async deleteWorkspaceRejects(
    params: WorkspaceParams,
    expectation: Expectation
  ): Promise<TestResult> {
    return rejection(() => ragDeleteWorkspace({ workspace: params.workspace }), expectation)
  }
}

async function rejection(
  call: () => Promise<unknown>,
  expectation: Expectation
): Promise<TestResult> {
  try {
    await call()
  } catch (error) {
    return ValidationHelpers.validate(
      error instanceof Error ? error.message : String(error),
      expectation
    )
  }
  return { passed: false, output: 'The call succeeded; it must be refused' }
}
