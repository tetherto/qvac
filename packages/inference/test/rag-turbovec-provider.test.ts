import test from 'brittle'
import env from 'bare-env'
import { z } from 'zod'
import {
  ERR_CODES,
  HyperDBAdapter,
  QvacErrorRAG,
  TurboVecAdapter,
  type TurboVecIndexProvider
} from '@qvac/rag'
import { clearPlugins, registerPlugin } from '@/plugins'
import {
  closeRagInstance,
  deleteWorkspace,
  getRagDbAdapter,
  isWorkspaceLoaded
} from '@/rag/rag-workspace-manager'

const TURBOVEC_ROLLOUT_ENV = 'QVAC_RAG_TURBOVEC'

function workspaceName(suffix: string) {
  return `test-turbovec-provider-${suffix}-${Date.now()}-${Math.random().toString(16).slice(2)}`
}

function restoreEnv(value: string | undefined) {
  env[TURBOVEC_ROLLOUT_ENV] = value ?? ''
}

async function cleanupWorkspace(workspace: string) {
  if (isWorkspaceLoaded(workspace)) {
    await closeRagInstance(workspace)
  }
  await deleteWorkspace(workspace)
}

test('TurboVec workspace failure leaves the workspace unpinned', async (t) => {
  const workspace = workspaceName('missing')
  const originalFlag = env[TURBOVEC_ROLLOUT_ENV]
  clearPlugins()
  env[TURBOVEC_ROLLOUT_ENV] = '1'

  try {
    try {
      await getRagDbAdapter(workspace)
      t.fail('workspace creation should require a provider')
    } catch (error) {
      t.ok(error instanceof QvacErrorRAG)
      if (error instanceof QvacErrorRAG) {
        t.is(error.code, ERR_CODES.DEPENDENCY_REQUIRED)
      }
    }

    env[TURBOVEC_ROLLOUT_ENV] = '0'
    const adapter = await getRagDbAdapter(workspace)
    t.ok(adapter instanceof HyperDBAdapter)
  } finally {
    restoreEnv(originalFlag)
    clearPlugins()
    await cleanupWorkspace(workspace)
  }
})

test('TurboVec workspace consumes a registered plugin provider', async (t) => {
  const workspace = workspaceName('registered')
  const originalFlag = env[TURBOVEC_ROLLOUT_ENV]
  const provider = {
    create() {
      throw new Error('not used for an empty workspace')
    },
    load() {
      throw new Error('not used for an empty workspace')
    }
  } as TurboVecIndexProvider

  clearPlugins()
  registerPlugin({
    modelType: 'test-turbovec-provider',
    displayName: 'TurboVec Provider Test',
    addonPackage: '@qvac/test-addon',
    loadConfigSchema: z.object({}),
    createModel() {
      return {
        model: { load: async function () {} }
      }
    },
    handlers: {},
    capabilities: {
      turbovecIndexProvider: provider
    }
  })
  env[TURBOVEC_ROLLOUT_ENV] = '1'

  try {
    const adapter = await getRagDbAdapter(workspace)
    t.ok(adapter instanceof TurboVecAdapter)
  } finally {
    restoreEnv(originalFlag)
    clearPlugins()
    await cleanupWorkspace(workspace)
  }
})

test('RAG workspace keeps its pinned adapter when the rollout flag changes', async (t) => {
  const turboWorkspace = workspaceName('pinned-turbo')
  const hyperdbWorkspace = workspaceName('pinned-hyperdb')
  const originalFlag = env[TURBOVEC_ROLLOUT_ENV]
  const provider = {
    create() {
      throw new Error('not used for an empty workspace')
    },
    load() {
      throw new Error('not used for an empty workspace')
    }
  } as TurboVecIndexProvider

  clearPlugins()
  registerPlugin({
    modelType: 'test-turbovec-pin',
    displayName: 'TurboVec Pin Test',
    addonPackage: '@qvac/test-addon',
    loadConfigSchema: z.object({}),
    createModel() {
      return {
        model: { load: async function () {} }
      }
    },
    handlers: {},
    capabilities: {
      turbovecIndexProvider: provider
    }
  })

  try {
    env[TURBOVEC_ROLLOUT_ENV] = '1'
    const turboAdapter = await getRagDbAdapter(turboWorkspace)
    t.ok(turboAdapter instanceof TurboVecAdapter)
    await closeRagInstance(turboWorkspace)

    env[TURBOVEC_ROLLOUT_ENV] = '0'
    const reopenedTurboAdapter = await getRagDbAdapter(turboWorkspace)
    t.ok(reopenedTurboAdapter instanceof TurboVecAdapter)
    await closeRagInstance(turboWorkspace)

    const hyperdbAdapter = await getRagDbAdapter(hyperdbWorkspace)
    t.ok(hyperdbAdapter instanceof HyperDBAdapter)
    await closeRagInstance(hyperdbWorkspace)

    env[TURBOVEC_ROLLOUT_ENV] = '1'
    const reopenedHyperdbAdapter = await getRagDbAdapter(hyperdbWorkspace)
    t.ok(reopenedHyperdbAdapter instanceof HyperDBAdapter)
  } finally {
    restoreEnv(originalFlag)
    clearPlugins()
    await cleanupWorkspace(turboWorkspace)
    await cleanupWorkspace(hyperdbWorkspace)
  }
})
