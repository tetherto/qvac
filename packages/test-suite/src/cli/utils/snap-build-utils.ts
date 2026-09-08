import * as fs from 'node:fs'
import * as path from 'node:path'

export function resolveSnapArtifactOutputPath(appDir: string, artifactPath: string): string {
  if (!artifactPath.endsWith('.snap')) {
    throw new Error(`Snap artifact path must end with .snap: ${artifactPath}`)
  }

  const appRoot = path.resolve(appDir)
  const resolved = path.resolve(appRoot, artifactPath)
  const relative = path.relative(appRoot, resolved)
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error(`Snap artifact path must stay inside the app directory: ${artifactPath}`)
  }

  let parent = path.dirname(resolved)
  while (parent !== appRoot) {
    if (fs.existsSync(parent) && fs.lstatSync(parent).isSymbolicLink()) {
      throw new Error(`Snap artifact path must not use a symlinked directory: ${artifactPath}`)
    }
    parent = path.dirname(parent)
  }
  if (fs.existsSync(resolved)) {
    const artifact = fs.lstatSync(resolved)
    if (artifact.isSymbolicLink()) {
      throw new Error(`Snap artifact path must not be a symlink: ${artifactPath}`)
    }
    if (!artifact.isFile()) {
      throw new Error(`Snap artifact path must be a regular file: ${artifactPath}`)
    }
  }

  return resolved
}

export function resolveSnapArtifactPath(appDir: string, artifactPath: string): string {
  const resolved = resolveSnapArtifactOutputPath(appDir, artifactPath)
  if (!fs.existsSync(resolved) || !fs.lstatSync(resolved).isFile()) {
    throw new Error(`Snap artifact not found: ${resolved}`)
  }

  return resolved
}
