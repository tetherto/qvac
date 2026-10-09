import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { extractBarePackHeader, extractPackedString } from '@/commands/bundle/manifest'

export const SPLIT_ADDON = '@qvac/fake-ggml'
export const SPLIT_ADDON_VERSION = '1.2.3'
export const SPLIT_ADDON_ANDROID_PACKAGE = `${SPLIT_ADDON}-android-arm64`
export const SPLIT_ADDON_IOS_PACKAGE = `${SPLIT_ADDON}-ios`
/** A split addon that `SPLIT_ADDON` depends on, the way the ggml addons depend on `@qvac/fabric`. */
export const RUNTIME_ADDON = '@qvac/fake-runtime'
export const RUNTIME_ADDON_VERSION = '0.4.0'
export const RUNTIME_ADDON_ANDROID_PACKAGE = `${RUNTIME_ADDON}-android-arm64`
export const RUNTIME_ADDON_IOS_PACKAGE = `${RUNTIME_ADDON}-ios`

export interface SplitAddonProjectOptions {
  layout?: 'hoisted' | 'pnpm'
  /**
   * Make `SPLIT_ADDON` require `RUNTIME_ADDON`. The project never lists the
   * runtime: under pnpm it is linked beside the addon in the store and in
   * `.pnpm/node_modules`, and in the hoisted layout it is nested in the
   * addon's own node_modules.
   */
  withRuntime?: boolean
}

function writeFile(filePath: string, content: string) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  fs.writeFileSync(filePath, content)
}

function link(target: string, linkPath: string) {
  fs.mkdirSync(path.dirname(linkPath), { recursive: true })
  fs.symlinkSync(target, linkPath, 'dir')
}

/**
 * A project whose only plugin loads a split addon: `@qvac/fake-ggml` ships no
 * prebuilds and names its platform packages in a `#host-addon` map, the way
 * `@qvac/fabric` and the speech addons do. No platform package is installed. The SDK is reachable at `sdkDir` inside the project,
 * with a pnpm lockfile beside it.
 *
 * The `pnpm` layout reproduces pnpm's isolated install: the SDK and the addon
 * live in `node_modules/.pnpm`, `sdkDir` is a link to the SDK, and the addon
 * is linked only beside the SDK and in `.pnpm/node_modules`, never in the
 * project's top-level node_modules.
 *
 * bare-pack keys the bundle graph relative to the working directory while the
 * manifest and verifier read the keys relative to the project root, so this
 * changes into the project the way running from the app does. `cleanup`
 * restores the working directory and removes the project.
 */
export function createSplitAddonProject(sdkDir: string, options: SplitAddonProjectOptions = {}) {
  const { layout = 'hoisted', withRuntime = false } = options
  const projectRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'qvac-split-addon-')))
  const originalCwd = process.cwd()
  process.chdir(projectRoot)

  const store = path.join(projectRoot, 'node_modules', '.pnpm')
  const sdkStoreDir = path.join(store, '@qvac+sdk@0.0.0', 'node_modules')
  const addonStoreDir = path.join(store, `@qvac+fake-ggml@${SPLIT_ADDON_VERSION}`, 'node_modules')
  const sdkPath = path.join(projectRoot, sdkDir)
  const sdkRoot = layout === 'pnpm' ? path.join(sdkStoreDir, '@qvac', 'sdk') : sdkPath
  const addonRoot =
    layout === 'pnpm'
      ? path.join(addonStoreDir, ...SPLIT_ADDON.split('/'))
      : path.join(projectRoot, 'node_modules', ...SPLIT_ADDON.split('/'))

  writeFile(
    path.join(sdkRoot, 'package.json'),
    JSON.stringify({
      name: '@qvac/sdk',
      type: 'module',
      exports: {
        './worker-lifecycle': './dist/worker-lifecycle.js',
        './plugins': './dist/plugins.js',
        './logging': './dist/logging.js',
        './llamacpp-completion/plugin': './dist/llm-plugin.js'
      }
    })
  )
  writeFile(path.join(sdkRoot, 'bare-imports.json'), '{}\n')
  writeFile(
    path.join(sdkRoot, 'dist', 'worker-lifecycle.js'),
    'export function initializeWorker() { return { hasRPCConfig: false } }\n' +
      'export function ensureRPCSetup() {}\n'
  )
  writeFile(path.join(sdkRoot, 'dist', 'plugins.js'), 'export function registerPlugin() {}\n')
  writeFile(
    path.join(sdkRoot, 'dist', 'logging.js'),
    'export function getServerLogger() { return { info() {} } }\n'
  )
  writeFile(
    path.join(sdkRoot, 'dist', 'llm-plugin.js'),
    `import addon from '${SPLIT_ADDON}'\nexport const llmPlugin = { addon }\n`
  )

  writeSplitAddon(addonRoot, SPLIT_ADDON, SPLIT_ADDON_VERSION, withRuntime ? RUNTIME_ADDON : null)

  if (withRuntime) {
    const runtimeRoot =
      layout === 'pnpm'
        ? path.join(
            store,
            `@qvac+fake-runtime@${RUNTIME_ADDON_VERSION}`,
            'node_modules',
            ...RUNTIME_ADDON.split('/')
          )
        : path.join(addonRoot, 'node_modules', ...RUNTIME_ADDON.split('/'))
    writeSplitAddon(runtimeRoot, RUNTIME_ADDON, RUNTIME_ADDON_VERSION, null)
    if (layout === 'pnpm') {
      link(runtimeRoot, path.join(addonStoreDir, ...RUNTIME_ADDON.split('/')))
      link(runtimeRoot, path.join(store, 'node_modules', ...RUNTIME_ADDON.split('/')))
    }
  }

  if (layout === 'pnpm') {
    link(sdkRoot, sdkPath)
    link(addonRoot, path.join(sdkStoreDir, ...SPLIT_ADDON.split('/')))
    link(addonRoot, path.join(store, 'node_modules', ...SPLIT_ADDON.split('/')))
    writeFile(path.join(projectRoot, 'node_modules', '.modules.yaml'), 'layoutVersion: 5\n')
  }

  const configPath = path.join(projectRoot, 'qvac.config.json')
  writeFile(configPath, JSON.stringify({ plugins: ['@qvac/sdk/llamacpp-completion/plugin'] }))
  writeFile(path.join(projectRoot, 'pnpm-lock.yaml'), '')

  return {
    projectRoot,
    sdkPath,
    configPath,
    cleanup() {
      process.chdir(originalCwd)
      fs.rmSync(projectRoot, { recursive: true, force: true })
    }
  }
}

/**
 * A split addon's meta package: no prebuilds of its own, a one-line
 * `require('#host-addon')` binding, and a `#host-addon` map naming its platform
 * packages. Loads `dependency` first when one is given.
 */
function writeSplitAddon(root: string, name: string, version: string, dependency: string | null) {
  writeFile(
    path.join(root, 'package.json'),
    JSON.stringify({
      name,
      version,
      main: 'index.js',
      ...(dependency !== null ? { dependencies: { [dependency]: '*' } } : {}),
      imports: {
        '#host-addon': {
          android: { arm64: `${name}-android-arm64`, default: './addon-unavailable.js' },
          ios: `${name}-ios`,
          default: './addon-unavailable.js'
        }
      }
    })
  )
  writeFile(
    path.join(root, 'index.js'),
    (dependency !== null ? `require('${dependency}')\n` : '') +
      "module.exports = require('#host-addon')\n"
  )
  writeFile(path.join(root, 'addon-unavailable.js'), 'module.exports = null\n')
}

/** The module keys in the header of the project's `qvac/worker.bundle.js`. */
export function bundledModules(projectRoot: string) {
  const bundleText = fs.readFileSync(path.join(projectRoot, 'qvac', 'worker.bundle.js'), 'utf8')
  const header = extractBarePackHeader(extractPackedString(bundleText))
  return Object.keys(header.resolutions ?? {})
}
