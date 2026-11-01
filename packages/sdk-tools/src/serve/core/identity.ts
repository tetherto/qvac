import { createHmac } from 'node:crypto'

// Unauthenticated, so a client can check that a listener holds its key before
// sending the key itself. The proof covers the port the request arrived on, so
// a squatter cannot relay the challenge to a real server on another port.
export const IDENTITY_PATH = '/qvac/identity'

export const IDENTITY_NONCE_PATTERN = /^[A-Za-z0-9_-]{22,128}$/

export function identityProof(apiKey: string, nonce: string, port: number): string {
  return createHmac('sha256', apiKey)
    .update(`qvac-serve-identity-v1\n${port}\n${nonce}`)
    .digest('base64url')
}
