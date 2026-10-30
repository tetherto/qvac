import fs from 'node:fs'
import path from 'node:path'

/**
 * Symlinks `dependency`, found by walking up `node_modules` from `from`, into
 * `projectRoot/node_modules`, along with its dependencies, so a temporary
 * project resolves it the way a hoisted install would.
 */
export function linkDependency(
  projectRoot: string,
  dependency: string,
  from: string,
  optional = false
): void {
  const target = path.join(projectRoot, 'node_modules', dependency)
  if (fs.existsSync(target)) return

  let parent = from
  let source = path.join(parent, 'node_modules', dependency)
  while (!fs.existsSync(source) && parent !== path.dirname(parent)) {
    parent = path.dirname(parent)
    source = path.join(parent, 'node_modules', dependency)
  }
  if (optional && !fs.existsSync(source)) return

  source = fs.realpathSync(source)
  fs.mkdirSync(path.dirname(target), { recursive: true })
  fs.symlinkSync(source, target, 'junction')

  const pkg = JSON.parse(fs.readFileSync(path.join(source, 'package.json'), 'utf8')) as {
    dependencies?: Record<string, string>
    optionalDependencies?: Record<string, string>
    peerDependencies?: Record<string, string>
  }
  for (const child of Object.keys(pkg.dependencies ?? {})) {
    linkDependency(projectRoot, child, source)
  }
  for (const child of Object.keys({ ...pkg.optionalDependencies, ...pkg.peerDependencies })) {
    linkDependency(projectRoot, child, source, true)
  }
}
