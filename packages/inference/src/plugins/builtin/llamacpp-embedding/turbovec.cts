declare function require(id: '@qvac/turbovec-ggml'): typeof import('@qvac/turbovec-ggml')

export function getIdMapIndex() {
  try {
    return require('@qvac/turbovec-ggml').IdMapIndex
  } catch (err) {
    throw new Error(
      'Vector indexing requires the optional peer dependency @qvac/turbovec-ggml; install it to create or load an index',
      { cause: err }
    )
  }
}
