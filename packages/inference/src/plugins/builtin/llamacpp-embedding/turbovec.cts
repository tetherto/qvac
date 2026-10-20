declare function require(id: '@qvac/turbovec-ggml'): typeof import('@qvac/turbovec-ggml')

export function getIdMapIndex() {
  try {
    // Load TurboVec's native binding only when creating or loading an index,
    // so embedding-only use does not need it. Keep this synchronous while RAG
    // and vector-index callers expect immediate results. Async loading is coming in
    // a follow-up that will include coordinated changes in @qvac/rag and @qvac/inference.
    return require('@qvac/turbovec-ggml').IdMapIndex
  } catch (err) {
    throw new Error(
      'Vector indexing requires the optional peer dependency @qvac/turbovec-ggml; install it to create or load an index',
      { cause: err }
    )
  }
}
