import { QvacErrorRAG, ERR_CODES } from '../errors.js'
import type { FetchFn } from './fetch.js'

// Resolves the runtime fetch. `#fetch` maps to bare-fetch on Bare and to the
// fetch shim elsewhere. Resolution is deferred to call time so a missing
// implementation surfaces as QvacErrorRAG(DEPENDENCY_REQUIRED) with guidance,
// rather than an opaque module-resolution error at import.
async function resolveFetch(): Promise<FetchFn> {
  try {
    const fetchMod = await import('#fetch')
    return (fetchMod.default || fetchMod) as FetchFn
  } catch (error) {
    if (error instanceof QvacErrorRAG) throw error
    const code = (error as { code?: string }).code
    if (code === 'MODULE_NOT_FOUND' || code === 'ERR_MODULE_NOT_FOUND') {
      throw new QvacErrorRAG({
        code: ERR_CODES.DEPENDENCY_REQUIRED,
        adds: 'Fetch unavailable: #fetch could not resolve. Bare: install bare-fetch; otherwise ensure globalThis.fetch exists and your bundler supports package imports.',
        cause: error instanceof Error ? error : undefined
      })
    }
    throw error
  }
}

export default resolveFetch
