import { promises as fsp } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type stow from 'bare-stow'

type CommonJSStowOptions = Pick<stow.StowOptions, 'readModule' | 'aliases' | 'conditions'>

/**
 * bare-stow options that convert every ES module in the graph to CommonJS, for
 * a worklet that JavaScriptCore runs: Bare's JavaScriptCore backend has no ES
 * modules, and no module loader for `import()` either.
 */
export function commonJSStowOptions(): CommonJSStowOptions {
  const isModuleScope = packageScopeTypes()

  return {
    // A converted module loads as CommonJS, and its imports, now `require()`
    // calls, resolve as the imports they were.
    aliases: { '.js': '.cjs', '.mjs': '.cjs', '.ts': '.cjs', '.mts': '.cjs' },
    conditions: ['import'],
    async readModule(moduleURL) {
      const url = new URL(moduleURL.href)
      let source: Buffer
      try {
        source = await fsp.readFile(fileURLToPath(url))
      } catch {
        return null
      }
      if (!(await isESModule(url, isModuleScope))) return source
      return convertToCommonJS(url, source.toString())
    }
  }
}

async function isESModule(url: URL, isModuleScope: (dir: string) => Promise<boolean>) {
  switch (path.extname(url.pathname)) {
    case '.mjs':
    case '.mts':
      return true
    case '.js':
    case '.ts':
      return isModuleScope(path.dirname(fileURLToPath(url)))
    default:
      return false
  }
}

/** Whether the closest `package.json` above a folder declares `"type": "module"`. */
function packageScopeTypes() {
  const scopes = new Map<string, Promise<boolean>>()

  function isModuleScope(dir: string): Promise<boolean> {
    let scope = scopes.get(dir)
    if (scope === undefined) {
      scope = readScope(dir)
      scopes.set(dir, scope)
    }
    return scope
  }

  async function readScope(dir: string): Promise<boolean> {
    let manifest: string
    try {
      manifest = await fsp.readFile(path.join(dir, 'package.json'), 'utf8')
    } catch {
      const parent = path.dirname(dir)
      return parent === dir ? false : isModuleScope(parent)
    }
    try {
      return (JSON.parse(manifest) as { type?: unknown }).type === 'module'
    } catch {
      return false
    }
  }

  return isModuleScope
}

export async function convertToCommonJS(url: URL, source: string): Promise<string> {
  const { transform } = await import('esbuild')
  let result: Awaited<ReturnType<typeof transform>>
  try {
    result = await transform(source, {
      format: 'cjs',
      loader: /\.m?ts$/.test(url.pathname) ? 'ts' : 'js',
      // Not named as an ES module, which esbuild would import CommonJS into
      // as Node does: the default import of a module marked `__esModule`, as
      // a converted one is, stays its `default` export. Bare imports CommonJS
      // compiled from TypeScript the same way.
      sourcefile: url.href.replace(/\.m([jt]s)$/, '.$1'),
      // ES modules are strict.
      banner: "'use strict';",
      target: 'esnext',
      supported: { 'dynamic-import': false },
      logLevel: 'silent'
    })
  } catch (error) {
    const { errors } = error as { errors?: { text: string }[] }
    const reason = errors?.[0]?.text ?? (error instanceof Error ? error.message : String(error))
    throw new Error(`Cannot convert ${url.href} to CommonJS for JavaScriptCore: ${reason}`, {
      cause: error
    })
  }
  // CommonJS has no `import.meta`, which esbuild leaves empty.
  if (result.warnings.some((warning) => warning.id === 'empty-import-meta')) {
    throw new Error(
      `Cannot convert ${url.href} to CommonJS for JavaScriptCore: it reads import.meta`
    )
  }
  return result.code
}
