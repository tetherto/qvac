import { describe, expect, test } from 'bun:test'
import {
  mobileSyncMarkerUri,
  mobileSyncStoragePath
} from './storage-path.ts'

describe('mobile Sync storage path', () => {
  test('converts the durable Expo document URI to a Bare filesystem path', () => {
    expect(
      mobileSyncStoragePath(
        'file:///var/mobile/Containers/Data/Application/ABC/Documents/'
      )
    ).toBe(
      '/var/mobile/Containers/Data/Application/ABC/Documents/qvac-composable-runtime/sync'
    )
  })

  test('decodes escaped path segments before passing them to Bare', () => {
    expect(mobileSyncStoragePath('file:///app/My%20Documents')).toBe(
      '/app/My Documents/qvac-composable-runtime/sync'
    )
  })

  test('keeps an Expo file URI for checking the paired marker', () => {
    expect(mobileSyncMarkerUri('file:///app/My%20Documents/')).toBe(
      'file:///app/My%20Documents/qvac-composable-runtime/sync/.paired'
    )
  })
})
