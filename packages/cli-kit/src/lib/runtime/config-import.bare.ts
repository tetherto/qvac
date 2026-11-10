// Bare has no loader hooks, so a config's own import of @qvac/harness resolves from its folder only.
export async function importConfig(url: string) {
  if (url.endsWith('.ts')) {
    throw new Error('a qvac.config.ts needs the Node launcher: run qvac, or rename it to .mjs')
  }

  try {
    return await import(url)
  } catch (caught) {
    const error = caught as Error & { code?: string }
    const missing = new RegExp("Cannot find module '(@qvac/(?:harness|sdk)[^']*)'").exec(
      error.message
    )
    if (error.code !== 'MODULE_NOT_FOUND' || !missing) {
      throw error
    }

    throw new Error(
      `${missing[1]} is not installed beside ${new URL(url).pathname}. Install it there, or run qvac (Node), which supplies its own.`
    )
  }
}

export const resolveFrom = (specifier: string, parentURL: string) =>
  import.meta.resolve(specifier, parentURL)
