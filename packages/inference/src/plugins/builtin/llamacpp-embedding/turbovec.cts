declare function require(id: '@qvac/turbovec-ggml'): typeof import('@qvac/turbovec-ggml')

export function getIdMapIndex() {
  return require('@qvac/turbovec-ggml').IdMapIndex
}
