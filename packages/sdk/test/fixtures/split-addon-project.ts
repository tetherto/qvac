import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { readBundle } from '@/commands/bundle/read-bundle'
import { linkDependency } from './link-dependency'

const SDK_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')

export const SPLIT_ADDON = '@qvac/fake-ggml'
export const SPLIT_ADDON_VERSION = '1.2.3'
export const SPLIT_ADDON_ANDROID_PACKAGE = `${SPLIT_ADDON}-android-arm64`
export const SPLIT_ADDON_IOS_PACKAGE = `${SPLIT_ADDON}-ios`
/** A split addon that `SPLIT_ADDON` depends on, the way the ggml addons depend on `@qvac/fabric`. */
export const RUNTIME_ADDON = '@qvac/fake-runtime'
export const RUNTIME_ADDON_VERSION = '0.4.0'
export const RUNTIME_ADDON_ANDROID_PACKAGE = `${RUNTIME_ADDON}-android-arm64`

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
 * the speech addons do. The SDK is reachable at `sdkDir` inside the project,
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
        './worker': './dist/worker.js',
        './llamacpp-completion/plugin': './dist/llm-plugin.js'
      }
    })
  )
  writeFile(path.join(sdkRoot, 'bare-imports.json'), '{}\n')
  writeFile(
    path.join(sdkRoot, 'dist', 'worker.js'),
    'export function startWorker(ipc, ready) { ready(); return async () => {} }\n'
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

  linkDependency(projectRoot, 'bare-stow', SDK_DIR)
  linkDependency(projectRoot, 'bare-stow-target-react-native', SDK_DIR)

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
 * A package that ships no prebuilds and names its platform packages in a
 * `#host-addon` map, loading `dependency` first when one is given.
 */
function writeSplitAddon(root: string, name: string, version: string, dependency: string | null) {
  writeFile(
    path.join(root, 'package.json'),
    JSON.stringify({
      name,
      version,
      addon: true,
      main: 'index.js',
      ...(dependency !== null ? { dependencies: { [dependency]: '*' } } : {}),
      imports: {
        '#host-addon': {
          android: {
            arm64: [`${name}-android-arm64`, './addon-unavailable.js'],
            default: './addon-unavailable.js'
          },
          ios: [`${name}-ios`, './addon-unavailable.js'],
          default: './addon-unavailable.js'
        }
      }
    })
  )
  writeFile(
    path.join(root, 'index.js'),
    (dependency !== null ? `require('${dependency}')\n` : '') +
      'let addon\n' +
      'try {\n' +
      '  addon = require.addon()\n' +
      '} catch {\n' +
      "  addon = require('#host-addon')\n" +
      '}\n' +
      'module.exports = addon\n'
  )
  writeFile(path.join(root, 'addon-unavailable.js'), 'module.exports = null\n')
}

/** The module keys of the project's phone bundle. */
export async function bundledModules(projectRoot: string) {
  const bundle = await readBundle(path.join(projectRoot, 'qvac', 'worker', 'index.bundle.mjs'))
  return Object.keys(bundle.resolutions)
}
