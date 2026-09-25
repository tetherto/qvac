import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { extractBarePackHeader, extractPackedString } from '@/commands/bundle/manifest'

export const SPLIT_ADDON = '@qvac/fake-ggml'
export const SPLIT_ADDON_VERSION = '1.2.3'
export const SPLIT_ADDON_ANDROID_PACKAGE = `${SPLIT_ADDON}-android-arm64`
export const SPLIT_ADDON_IOS_PACKAGE = `${SPLIT_ADDON}-ios`

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
export function createSplitAddonProject(sdkDir: string, layout: 'hoisted' | 'pnpm' = 'hoisted') {
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

  writeFile(
    path.join(addonRoot, 'package.json'),
    JSON.stringify({
      name: SPLIT_ADDON,
      version: SPLIT_ADDON_VERSION,
      addon: true,
      main: 'index.js',
      imports: {
        '#host-addon': {
          android: {
            arm64: [SPLIT_ADDON_ANDROID_PACKAGE, './addon-unavailable.js'],
            default: './addon-unavailable.js'
          },
          ios: [SPLIT_ADDON_IOS_PACKAGE, './addon-unavailable.js'],
          default: './addon-unavailable.js'
        }
      }
    })
  )
  writeFile(
    path.join(addonRoot, 'index.js'),
    'let addon\n' +
      'try {\n' +
      '  addon = require.addon()\n' +
      '} catch {\n' +
      "  addon = require('#host-addon')\n" +
      '}\n' +
      'module.exports = addon\n'
  )
  writeFile(path.join(addonRoot, 'addon-unavailable.js'), 'module.exports = null\n')

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

/** The module keys in the header of the project's `qvac/worker.bundle.js`. */
export function bundledModules(projectRoot: string) {
  const bundleText = fs.readFileSync(path.join(projectRoot, 'qvac', 'worker.bundle.js'), 'utf8')
  const header = extractBarePackHeader(extractPackedString(bundleText))
  return Object.keys(header.resolutions ?? {})
}
