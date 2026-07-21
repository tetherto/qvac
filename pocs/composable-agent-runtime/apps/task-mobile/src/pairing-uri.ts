export interface PairingInvite {
  readonly invite: string
  readonly expiresAt: number
}

export function parsePairingUri(uri: string, now = Date.now()): PairingInvite {
  let parsed: URL
  try {
    parsed = new URL(uri.trim())
  } catch (error) {
    throw new Error('Pairing URI must use qvac-poc://pair', { cause: error })
  }

  if (
    parsed.protocol !== 'qvac-poc:' ||
    parsed.hostname !== 'pair' ||
    (parsed.pathname !== '' && parsed.pathname !== '/')
  ) {
    throw new Error('Pairing URI must use qvac-poc://pair')
  }

  for (const key of parsed.searchParams.keys()) {
    if (key !== 'invite' && key !== 'expiresAt') {
      throw new Error(`Pairing URI contains unsupported parameter: ${key}`)
    }
  }

  const invite = parsed.searchParams.get('invite') ?? ''
  if (
    !/^[A-Za-z0-9_-]+$/.test(invite) ||
    invite.length % 4 === 1
  ) {
    throw new Error('Pairing URI invite must be base64url data')
  }

  const encodedExpiry = parsed.searchParams.get('expiresAt') ?? ''
  if (!/^[0-9]+$/.test(encodedExpiry)) {
    throw new Error('Pairing URI expiresAt must be an integer timestamp')
  }
  const expiresAt = Number(encodedExpiry)
  if (!Number.isSafeInteger(expiresAt)) {
    throw new Error('Pairing URI expiresAt must be a safe integer timestamp')
  }
  if (expiresAt <= now) throw new Error('Pairing invite has expired')

  return { invite, expiresAt }
}
