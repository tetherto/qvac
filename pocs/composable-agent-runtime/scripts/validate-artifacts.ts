import {
  listStagedResources,
  validateArtifacts,
  type ExecutionRealm,
  type NativeAddonIdentity
} from '../packages/assistant/lib/artifact-validation.ts'
import { readFile, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'

interface StackManifest {
  readonly realms: readonly ExecutionRealm[]
  readonly singletonPackages: readonly string[]
  readonly sdkSource: {
    readonly addons: readonly NativeAddonIdentity[]
  }
  readonly workers: {
    readonly sync: {
      readonly nativeAddons: readonly NativeAddonIdentity[]
    }
    readonly harness: {
      readonly nativeAddons: readonly NativeAddonIdentity[]
    }
  }
  readonly mergedAddons: readonly NativeAddonIdentity[]
}

const flags = parseFlags(Bun.argv.slice(2))
const projectRoot = path.resolve(flags.projectRoot ?? process.cwd())
const manifestPath = path.join(projectRoot, 'qvac', 'assistant-stack.manifest.json')
const manifest = await readStackManifest(manifestPath)
const stagedResources = flags.artifact
  ? await readArtifactResources(path.resolve(flags.artifact), flags.mode)
  : undefined
const report = await validateArtifacts({
  projectRoot,
  realms: manifest.realms,
  singletonPackages: manifest.singletonPackages,
  sdkAddons: manifest.sdkSource.addons,
  workers: [
    { name: 'sync', nativeAddons: manifest.workers.sync.nativeAddons },
    { name: 'harness', nativeAddons: manifest.workers.harness.nativeAddons }
  ],
  mergedAddons: manifest.mergedAddons,
  ...(flags.mode ? { targetHost: flags.mode } : {}),
  ...(stagedResources ? { stagedResources } : {})
})
const output = `${JSON.stringify(report, null, 2)}\n`
if (flags.json) await writeFile(path.resolve(flags.json), output)
process.stdout.write(output)
if (report.ok) {
  process.stderr.write(
    `Artifact validation passed: ${report.realms.length} realms, ` +
      `${report.nativeAddons.length} native addons.\n`
  )
} else {
  process.stderr.write(
    `Artifact validation failed with ${report.errors.length} error(s):\n` +
      report.errors.map((issue) => `- [${issue.code}] ${issue.message}`).join('\n') +
      '\n'
  )
  process.exitCode = 1
}

async function readStackManifest(filePath: string): Promise<StackManifest> {
  let parsed: unknown
  try {
    parsed = JSON.parse(await readFile(filePath, 'utf8'))
  } catch (error) {
    throw new Error(`Unable to read assistant stack manifest at ${filePath}`, {
      cause: error
    })
  }
  if (!isStackManifest(parsed)) {
    throw new Error(`Malformed assistant stack manifest at ${filePath}`)
  }
  return parsed
}

function isStackManifest(value: unknown): value is StackManifest {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const candidate = value as Partial<StackManifest>
  return (
    Array.isArray(candidate.realms) &&
    Array.isArray(candidate.singletonPackages) &&
    Array.isArray(candidate.sdkSource?.addons) &&
    Array.isArray(candidate.workers?.sync?.nativeAddons) &&
    Array.isArray(candidate.workers?.harness?.nativeAddons) &&
    Array.isArray(candidate.mergedAddons)
  )
}

async function readArtifactResources(
  artifactPath: string,
  mode: 'android' | 'desktop' | undefined
) {
  const info = await stat(artifactPath)
  if (info.isDirectory()) {
    if (mode === 'android') throw new Error('Android artifact mode requires an APK or AAB')
    return listStagedResources(artifactPath)
  }
  if (mode === 'desktop') throw new Error('Desktop artifact mode requires a staged directory')
  if (!info.isFile() || !/\.(apk|aab|zip)$/i.test(artifactPath)) {
    throw new Error(`Unsupported artifact path: ${artifactPath}`)
  }
  const child = Bun.spawn(['unzip', '-Z1', artifactPath], {
    stdout: 'pipe',
    stderr: 'pipe'
  })
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text()
  ])
  if (exitCode !== 0) {
    throw new Error(`Unable to inspect ${artifactPath}: ${stderr.trim()}`)
  }
  return stdout
    .split('\n')
    .map((entry) => entry.trim())
    .filter(Boolean)
}

function parseFlags(args: readonly string[]) {
  const result: {
    projectRoot?: string
    artifact?: string
    json?: string
    mode?: 'android' | 'desktop'
  } = {}
  for (let index = 0; index < args.length; index += 1) {
    const flag = args[index]
    const value = args[index + 1]
    if (!value) throw new Error(`Missing value for ${flag}`)
    if (flag === '--project-root') result.projectRoot = value
    else if (flag === '--artifact') result.artifact = value
    else if (flag === '--json') result.json = value
    else if (flag === '--mode' && (value === 'android' || value === 'desktop')) {
      result.mode = value
    }
    else throw new Error(`Unknown flag: ${flag}`)
    index += 1
  }
  return result
}
