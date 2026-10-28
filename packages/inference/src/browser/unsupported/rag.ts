import { unsupported } from '../unsupported'

const stub = unsupported('@qvac/rag (RAG)')

export default stub
export const HyperDBAdapter = stub.HyperDBAdapter
export const LLMChunkAdapter = stub.LLMChunkAdapter
export const QvacErrorRAG = stub.QvacErrorRAG
export const RAG = stub.RAG
export const TurboVecAdapter = stub.TurboVecAdapter
// Read at import time; see rag-errors.ts.
export const ERR_CODES: Record<string, number> = {}
