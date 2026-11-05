/** The package selected by a split addon's host map, including legacy fallback arrays. */
export function platformPackageForHost(meta, host) {
  const dash = host.indexOf('-')
  const platform = dash === -1 ? host : host.slice(0, dash)
  const arch = dash === -1 ? 'arm64' : host.slice(dash + 1)
  const hostMap = meta.imports?.['#host-addon']?.[platform]
  const branch = typeof hostMap === 'string' || Array.isArray(hostMap) ? hostMap : hostMap?.[arch]
  const candidate = Array.isArray(branch) ? branch[0] : branch
  return typeof candidate === 'string' && candidate.startsWith(`${meta.name}-`) ? candidate : null
}
