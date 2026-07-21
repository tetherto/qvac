const SYNC_STORAGE_DIRECTORY = 'qvac-composable-runtime/sync'

export function mobileSyncStoragePath(documentUri: string) {
  const parsed = new URL(documentUri)
  if (parsed.protocol !== 'file:') {
    throw new Error('Mobile Sync document storage must use a file URI')
  }
  const documentPath = decodeURIComponent(parsed.pathname).replace(/\/$/, '')
  return `${documentPath}/${SYNC_STORAGE_DIRECTORY}`
}

export function mobileSyncMarkerUri(documentUri: string) {
  const parsed = new URL(documentUri)
  if (parsed.protocol !== 'file:') {
    throw new Error('Mobile Sync document storage must use a file URI')
  }
  return `${parsed.href.replace(/\/$/, '')}/${SYNC_STORAGE_DIRECTORY}/.paired`
}
