import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { DEFAULT_SDK_NAME } from '@/doctor/constants'
import type { Check } from '@/doctor/check'

// Locate @qvac/sdk the same way a consumer project's runtime would, so
// we correctly find the package whether installed locally, hoisted in a
// monorepo, or linked via workspaces.
export function resolvePackageJson(projectRoot: string, name = DEFAULT_SDK_NAME): string | null {
  try {
    const req = createRequire(path.join(projectRoot, 'package.json'))
    for (const spec of [`${name}/package.json`, `${name}/package`]) {
      try {
        return req.resolve(spec)
      } catch {
        // try the next spec
      }
    }
    // Packages may export their entry point without exporting the manifest.
    let dir = path.dirname(req.resolve(name))
    for (;;) {
      const manifest = path.join(dir, 'package.json')
      if (fs.existsSync(manifest)) {
        const pkg = JSON.parse(fs.readFileSync(manifest, 'utf8')) as { name?: string }
        if (pkg.name === name) return manifest
      }
      const parent = path.dirname(dir)
      if (parent === dir) return null
      dir = parent
    }
  } catch {
    return null
  }
}

export function resolveSdkEntrypoint(projectRoot: string): string {
  const req = createRequire(path.join(projectRoot, 'package.json'))
  return req.resolve(DEFAULT_SDK_NAME)
}

export const checkSdkInstalled: Check = (ctx) => {
  const projectRoot = ctx.projectRoot
  const pkgPath = resolvePackageJson(projectRoot)
  if (pkgPath === null) {
    return {
      id: 'project-sdk',
      label: `${DEFAULT_SDK_NAME} resolvable from project`,
      status: 'warn',
      severity: 'recommended',
      value: 'not found',
      hint: `Run 'npm install ${DEFAULT_SDK_NAME}' in ${projectRoot} to install the SDK.`
    }
  }
  try {
    const raw = fs.readFileSync(pkgPath, 'utf8')
    const pkg = JSON.parse(raw) as { version?: string }
    return {
      id: 'project-sdk',
      label: `${DEFAULT_SDK_NAME} resolvable from project`,
      status: 'pass',
      severity: 'recommended',
      value: pkg.version !== undefined ? `v${pkg.version}` : 'installed'
    }
  } catch {
    return {
      id: 'project-sdk',
      label: `${DEFAULT_SDK_NAME} resolvable from project`,
      status: 'warn',
      severity: 'recommended',
      value: 'unreadable',
      hint: `Found ${pkgPath} but could not read its version.`
    }
  }
}
