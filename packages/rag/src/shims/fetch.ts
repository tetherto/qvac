import { QvacErrorRAG, ERR_CODES } from '../errors.js'

export type FetchFn = (...args: any[]) => Promise<unknown>

function ensureFetch(): FetchFn {
  const runtime = globalThis as { fetch?: FetchFn }
  if (typeof runtime.fetch === 'function') {
    return runtime.fetch.bind(globalThis)
  }
  throw new QvacErrorRAG({
    code: ERR_CODES.DEPENDENCY_REQUIRED,
    adds: 'No fetch implementation found. Please ensure a Fetch-compatible globalThis.fetch is available. Bare: install bare-fetch. Node 18+ and browser/RN environments normally provide fetch globally.'
  })
}

function fetchProxy(...args: any[]): Promise<unknown> {
  return ensureFetch()(...args)
}

export default fetchProxy
