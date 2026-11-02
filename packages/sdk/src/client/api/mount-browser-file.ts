import { mountBrowserFile as mountWithTransport } from '#rpc'

/**
 * Browser only. Makes a `File` the user picked (from a file input or a folder
 * they granted) loadable without copying it into browser storage. Pass the
 * returned path as `modelSrc` to `loadModel`. The file stays readable until
 * the page reloads or `close()` runs.
 *
 * @example
 * const modelSrc = await mountBrowserFile(input.files[0])
 * const modelId = await loadModel({ modelSrc, modelType: 'llamacpp-completion' })
 */
export function mountBrowserFile(file: File): Promise<string> {
  return mountWithTransport(file)
}
