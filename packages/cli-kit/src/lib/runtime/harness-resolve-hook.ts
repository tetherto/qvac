import type { ResolveHook } from 'node:module'
// A plugin a qvac.config imports reaches for @qvac/harness, which the user's project rarely installs.
let fallback: string

export function initialize(data: { parentURL: string }) {
  fallback = data.parentURL
}

export const resolve: ResolveHook = async (specifier, context, next) => {
  if (specifier.startsWith('qvac-resolve:')) {
    const [target, parentURL] = JSON.parse(decodeURIComponent(specifier.slice(13))) as [
      string,
      string
    ]
    const resolved = await next(target, { ...context, parentURL })
    return {
      url: `data:text/javascript,${encodeURIComponent(`export default ${JSON.stringify(resolved.url)}`)}`,
      shortCircuit: true
    }
  }

  try {
    return await next(specifier, context)
  } catch (error) {
    if (!/^@qvac\/(harness|sdk)(\/|$)/.test(specifier)) {
      throw error
    }

    return next(specifier, { ...context, parentURL: fallback })
  }
}
