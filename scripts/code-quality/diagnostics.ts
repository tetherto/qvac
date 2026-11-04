export function stableErrorMessage(error: unknown, root: string): string {
  const message = error instanceof Error ? error.message : String(error)
  const repositoryRoot = root.replace(/[\\/]+$/, '')

  return repositoryRoot === ''
    ? message
    : message.replaceAll(repositoryRoot, '<repository>')
}
