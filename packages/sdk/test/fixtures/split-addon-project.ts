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
  /**
   * Make `SPLIT_ADDON` require `RUNTIME_ADDON`. The project never lists the
   * runtime; it is nested in the addon's own node_modules.
   */
  withRuntime?: boolean
}

function writeFile(filePath: string, content: string) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  fs.writeFileSync(filePath, content)
}

/**
 * A project whose only plugin loads a split addon: `@qvac/fake-ggml` ships no
 * prebuilds and names its platform packages in a `#host-addon` map, the way
 * the speech addons do. The SDK is reachable at `sdkDir` inside the project,
 * with a pnpm lockfile beside it.
 *
 * bare-pack keys the bundle graph relative to the working directory while the
 * manifest and verifier read the keys relative to the project root, so this
 * changes into the project the way running from the app does. `cleanup`
 * restores the working directory and removes the project.
 */
export function createSplitAddonProject(sdkDir: string, options: SplitAddonProjectOptions = {}) {
  const { withRuntime = false } = options
  const projectRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'qvac-split-addon-')))
  const originalCwd = process.cwd()
  process.chdir(projectRoot)

  const sdkPath = path.join(projectRoot, sdkDir)
  const addonRoot = path.join(projectRoot, 'node_modules', ...SPLIT_ADDON.split('/'))

  writeFile(
    path.join(sdkPath, 'package.json'),
    JSON.stringify({
      name: '@qvac/sdk',
      type: 'module',
      exports: {
        './worker': './dist/worker.js',
        './llamacpp-completion/plugin': './dist/llm-plugin.js'
      }
    })
  )
  writeFile(path.join(sdkPath, 'bare-imports.json'), '{}\n')
  writeFile(
    path.join(sdkPath, 'dist', 'worker.js'),
    'export function startWorker(ipc, ready) { ready(); return async () => {} }\n'
  )
  writeFile(
    path.join(sdkPath, 'dist', 'llm-plugin.js'),
    `import addon from '${SPLIT_ADDON}'\nexport const llmPlugin = { addon }\n`
  )

  writeSplitAddon(addonRoot, SPLIT_ADDON, SPLIT_ADDON_VERSION, withRuntime ? RUNTIME_ADDON : null)

  if (withRuntime) {
    const runtimeRoot = path.join(addonRoot, 'node_modules', ...RUNTIME_ADDON.split('/'))
    writeSplitAddon(runtimeRoot, RUNTIME_ADDON, RUNTIME_ADDON_VERSION, null)
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
