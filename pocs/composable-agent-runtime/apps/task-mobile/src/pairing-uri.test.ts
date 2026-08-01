import { describe, expect, test } from 'bun:test'
import { parsePairingUri } from './pairing-uri.ts'

describe('pairing URI', () => {
  test('parses a valid unexpired pairing invite', () => {
    expect(
      parsePairingUri(
        'qvac-poc://pair?invite=Ab-_89&expiresAt=200000',
        100_000
      )
    ).toEqual({
      invite: 'Ab-_89',
      expiresAt: 200_000
    })
  })

  test('rejects malformed pairing URIs', () => {
    expect(() =>
      parsePairingUri(
        'qvac-poc://pair?invite=invalid!&expiresAt=200000',
        100_000
      )
    ).toThrow('Pairing URI invite must be base64url data')
  })

  test('rejects expired pairing invites', () => {
    expect(() =>
      parsePairingUri(
        'qvac-poc://pair?invite=Ab-_89&expiresAt=100000',
        100_000
      )
    ).toThrow('Pairing invite has expired')
  })
})
