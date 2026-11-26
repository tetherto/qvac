export interface RagOpsHost {
  root: string
  join(...parts: string[]): string
  removeDir(dir: string): Promise<void>
  listDir(dir: string): Promise<string[]>
  embed(modelId: string, text: string): Promise<number[]>
  indexProvider?: unknown
  fs?: unknown
}

export declare const SPACE: Record<string, unknown>

export declare const RAG_OPS: readonly string[]

export declare function createRagOps(
  host: RagOpsHost
): (op: string, params?: Record<string, unknown>) => Promise<Record<string, unknown>>
