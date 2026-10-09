export async function getHomeDir(): Promise<string> {
  const { Paths } = await import('expo-file-system')
  return Paths.document.uri.replace('file://', '')
}
