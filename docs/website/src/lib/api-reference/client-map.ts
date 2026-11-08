/**
 * Which contract method — and, for a multiplexed method, which variant — a
 * client function calls. The contract describes the wire request; the client
 * function is what a developer calls. Most share a name or differ by the
 * `Stream` suffix; the rest are listed here.
 *
 * A function that reaches no contract method (a client-side helper, or one
 * built on a plugin call) gets its signature and no field table.
 */

export interface ContractTarget {
  method: string
  /** For a multiplexed method: the discriminator field and the value this function sends. */
  variant?: { field: string; value: string }
}

const RAG = (value: string): ContractTarget => ({ method: 'rag', variant: { field: 'operation', value } })
const VECTOR_INDEX = (value: string): ContractTarget => ({
  method: 'vectorIndex',
  variant: { field: 'operation', value },
})

export const CLIENT_OVERRIDES: Readonly<Record<string, ContractTarget>> = {
  invokePlugin: { method: 'pluginInvoke' },
  invokePluginStream: { method: 'pluginInvokeStream' },
  ragChunk: RAG('chunk'),
  ragIngest: RAG('ingest'),
  ragSaveEmbeddings: RAG('saveEmbeddings'),
  ragSearch: RAG('search'),
  ragDeleteEmbeddings: RAG('deleteEmbeddings'),
  ragReindex: RAG('reindex'),
  ragListWorkspaces: RAG('listWorkspaces'),
  ragCloseWorkspace: RAG('closeWorkspace'),
  ragDeleteWorkspace: RAG('deleteWorkspace'),
  createVectorIndex: VECTOR_INDEX('create'),
  loadVectorIndex: VECTOR_INDEX('load'),
  worldCreateScene: { method: 'worldSceneStream' },
  worldStep: { method: 'worldStepStream' },
}

/** The contract target of a client function, or null when it has none. */
export function contractTargetOf(fn: string, methods: ReadonlySet<string>): ContractTarget | null {
  const override = CLIENT_OVERRIDES[fn]
  if (override) return methods.has(override.method) ? override : null
  if (methods.has(fn)) return { method: fn }
  if (methods.has(`${fn}Stream`)) return { method: `${fn}Stream` }
  return null
}
