import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { DEFAULT_SDK_NAME } from '../../bundle-sdk/constants.js'
import type { Check } from '../check.js'

// Locate @qvac/sdk the same way a consumer project's runtime would, so
// we correctly find the package whether installed locally, hoisted in a
// monorepo, or linked via workspaces.
function resolveSdkPackageJson (projectRoot: string): string | null {
  try {
    const req = createRequire(path.join(projectRoot, 'package.json'))
    for (const spec of [`${DEFAULT_SDK_NAME}/package.json`, `${DEFAULT_SDK_NAME}/package`]) {
      try {
        return req.resolve(spec)
      } catch {
        // try the next spec
      }
    }
    return null
  } catch {
    return null
  }
}

export const checkSdkInstalled: Check = (ctx) => {
  const projectRoot = ctx.projectRoot
  const pkgPath = resolveSdkPackageJson(projectRoot)
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
