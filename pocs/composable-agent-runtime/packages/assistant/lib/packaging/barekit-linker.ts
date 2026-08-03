import { readFile, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import path from 'node:path'

export async function pinBareKitLinkerProjectRoot(projectRoot: string) {
  const require = createRequire(path.join(projectRoot, 'package.json'))
  let packageJsonPath: string
  try {
    packageJsonPath = require.resolve('react-native-bare-kit/package.json')
  } catch {
    return
  }
  const packageRoot = path.dirname(packageJsonPath)
  for (const relativePath of ['android/link.mjs', 'ios/link.mjs']) {
    const linkerPath = path.join(packageRoot, relativePath)
    const source = await readFileStrict(linkerPath, `BareKit linker ${relativePath}`)
    const pattern = /^const projectRoot = .+$/m
    if (!pattern.test(source)) {
      throw new Error(`BareKit linker project-root declaration was not found: ${linkerPath}`)
    }
    await writeFile(
      linkerPath,
      source.replace(pattern, `const projectRoot = ${JSON.stringify(projectRoot)}`)
    )
  }
}

async function readFileStrict(filePath: string, label: string) {
  try {
    return await readFile(filePath, 'utf8')
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    throw new Error(`Failed to read ${label} at ${filePath}: ${message}`)
  }
}
