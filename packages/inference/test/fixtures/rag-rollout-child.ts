// A standalone consumer process for the RAG rollout tests. It runs the
// sequence a real Bare app runs: the first engine call resolves qvac.config
// from QVAC_CONFIG_PATH, then a RAG workspace open picks its adapter. The
// outcome goes to stdout as one JSON line for the parent test to assert on.
//
// argv: <workspace> <'provider' | 'no-provider'>
import { send, close } from '@/dispatch'
import { registerPlugin } from '@/plugins'
import { QvacErrorRAG, TurboVecAdapter } from '@qvac/rag'
import { closeRagInstance, getRagDbAdapter } from '@/rag/rag-workspace-manager'
import { ModelType } from '@/schemas'
import type { Request } from '@/schemas'
import { makeFakePlugin } from './fake-plugin'
import { observableIndexProvider, registerProviderPlugin } from './turbovec-provider'

interface ChildResult {
  ok: boolean
  adapter?: 'turbovec' | 'hyperdb'
  code?: string | number
}

async function main(): Promise<ChildResult> {
  const workspace = Bare.argv[2]
  const withProvider = Bare.argv[3] === 'provider'
  if (!workspace) {
    return { ok: false, code: 'usage: rag-rollout-child <workspace> <provider|no-provider>' }
  }

  registerPlugin(makeFakePlugin(ModelType.llamacppCompletion))
  if (withProvider) {
    registerProviderPlugin('rollout-child-turbovec', observableIndexProvider().provider)
  }

  // The first engine call resolves and latches the config file.
  await send({ type: 'heartbeat' } as unknown as Request)

  const adapter = await getRagDbAdapter(workspace)
  const adapterType = adapter instanceof TurboVecAdapter ? 'turbovec' : 'hyperdb'
  await closeRagInstance(workspace)
  return { ok: true, adapter: adapterType }
}

async function run() {
  let result: ChildResult
  try {
    result = await main()
  } catch (error) {
    result = { ok: false, code: error instanceof QvacErrorRAG ? error.code : String(error) }
  }
  try {
    await close()
  } catch {
    // The result line matters more than teardown noise.
  }
  console.log(JSON.stringify(result))
}

void run()
