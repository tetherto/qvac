import { createHmac, randomBytes } from 'node:crypto'

// Mirrors `qvac serve`'s unauthenticated identity route: the listener proves it
// holds the key for the port we dialed, so the key is never sent to a process
// that merely occupies that port.
const IDENTITY_PATH = '/qvac/identity'

function expectedProof(apiKey: string, nonce: string, port: number): string {
  return createHmac('sha256', apiKey)
    .update(`qvac-serve-identity-v1\n${port}\n${nonce}`)
    .digest('base64url')
}

export async function verifyServeIdentity(
  baseURL: string,
  apiKey: string,
  fetchImpl: typeof fetch,
  signal?: AbortSignal
): Promise<boolean> {
  const url = new URL(baseURL)
  const port = url.port === '' ? 80 : Number(url.port)
  const nonce = randomBytes(32).toString('base64url')
  const res = await fetchImpl(`${url.origin}${IDENTITY_PATH}?nonce=${nonce}`, {
    ...(signal === undefined ? {} : { signal })
  })
  if (!res.ok) return false
  const body = (await res.json().catch(() => undefined)) as { proof?: unknown } | undefined
  return body?.proof === expectedProof(apiKey, nonce, port)
}
