// Minimal router slice for coverage tests (parsed as text only).
export function route (): void {
  const method = 'POST'
  const path = '/v1/chat/completions'
  if (method === 'POST' && path === '/v1/chat/completions') {
    return
  }
  if (method === 'POST' && path === '/v1/embeddings') {
    return
  }
  if (method === 'GET' && path === '/v1/models') {
    return
  }
  if (method === 'GET' && path === '/v1/files') {
    return
  }
  if (method === 'POST' && path === '/v1/files') {
    return
  }
  const fileIdMatch = path.match(/^\/v1\/files\/([^/]+)$/)
  if (fileIdMatch && method === 'GET') {
    return
  }
}
