import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { pathToFileURL } from 'node:url'

export async function collectBuildMetadata(sdk, reactNativeBareKit) {
  const version = (manifest) =>
    fs.existsSync(manifest) ? JSON.parse(fs.readFileSync(manifest, 'utf8')).version : null
  const installed = (name) => version(path.join(sdk, 'node_modules', name, 'package.json'))
  const table = path.join(sdk, 'dist/src/commands/verify/bare-kit-runtimes.js')
  const runtime =
    reactNativeBareKit && fs.existsSync(table)
      ? (await import(pathToFileURL(table).href)).REACT_NATIVE_BARE_KIT_RUNTIMES[reactNativeBareKit]
      : undefined
  return {
    appCommit: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: sdk, encoding: 'utf8' }).trim(),
    uncommittedChanges: Boolean(
      execFileSync('git', ['status', '--porcelain', '--untracked-files=no'], {
        cwd: sdk,
        encoding: 'utf8'
      }).trim()
    ),
    preparedAt: new Date().toISOString(),
    versions: {
      sdk: version(path.join(sdk, 'package.json')),
      inference: installed('@qvac/inference'),
      nativeRpcServer: installed('@qvac/ggml-rpc-server'),
      nativeLlamacpp: installed('@qvac/llm-llamacpp'),
      desktopBareRuntimePackage: installed('bare-runtime'),
      ...(reactNativeBareKit && {
        mobile: {
          reactNativeBareKit,
          bareKit: runtime?.bareKit ?? null,
          bare: runtime?.bare ?? null,
          source: 'SDK runtime mapping; verify against native startup logs'
        }
      })
    }
  }
}
