import bundleId from 'bare-bundle-id'
import lex from 'bare-module-lexer'
import traverse from 'bare-module-traverse'
import pack from 'bare-pack'
import { listPrefix, readModule } from 'bare-pack/fs'
import strip from 'bare-type-stripper'
import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  generateWorkletHarness,
  workletHosts
} from './react-native-worklet-target'

type BareURL = import('bare-url')

const appRoot = new URL('../', import.meta.url) as unknown as BareURL
const generated = fileURLToPath(new URL('../generated/', import.meta.url).href)
const worklets = ['sync', 'harness', 'sdk'] as const
const linkedWorklets = new Set<(typeof worklets)[number]>(['sync', 'sdk'])

await rm(generated, { recursive: true, force: true })
await mkdir(generated, { recursive: true })

const bundleBytes: Record<string, number> = {}
const addonPackagesByWorklet: Record<string, string[]> = {}
for (const worklet of worklets) {
  const entry = new URL(
    `../worklets/__mobile-${worklet}.mjs`,
    import.meta.url
  ) as unknown as BareURL
  const startArguments =
    worklet === 'sync' ? ', Bare.argv[2]' : ''
  const entrySource = `\
import start from './${worklet}.ts'

await start(BareKit.IPC${startArguments})
`
  const addonParents = new Set<string>()
  const bundle = await pack(
    entry,
    {
      base: appRoot,
      hosts: workletHosts,
      linked: linkedWorklets.has(worklet),
      offload: false,
      resolve: ((entry, parentURL, options) =>
        resolveWorklet(entry, parentURL, {
          ...options,
          onAddon(parentURL) {
            addonParents.add(parentURL.href)
          }
        })) as NonNullable<import('bare-pack').PackOptions['resolve']>,
      aliases: {
        '.ts': '.js',
        '.mts': '.mjs',
        '.cts': '.cjs'
      }
    },
    (async (url: BareURL) => {
      if (url.href === entry.href) return entrySource
      const source = await readModule(url)
      if (source === null) return null
      return /\.(c|m)?ts$/.test(url.pathname) ? strip(source) : source
    }) as unknown as import('bare-pack').ReadModuleCallback,
    listPrefix as unknown as import('bare-pack').ListPrefixCallback
  )
  bundle.id = bundleId(bundle).toString('hex')

  const bundlePath = fileURLToPath(
    new URL(`../generated/${worklet}.bundle`, import.meta.url).href
  )
  await writeFile(bundlePath, bundle.toBuffer())

  const harness = generateWorkletHarness(`./${worklet}.bundle`)
  const harnessPath = fileURLToPath(
    new URL(`../generated/${worklet}.js`, import.meta.url).href
  )
  const typesPath = fileURLToPath(
    new URL(`../generated/${worklet}.d.ts`, import.meta.url).href
  )
  await writeFile(harnessPath, harness.source)
  await writeFile(typesPath, harness.types)

  console.log(`generated ${harnessPath}`)
  console.log(`generated ${typesPath}`)
  console.log(`generated ${bundlePath}`)
  bundleBytes[worklet] = (await stat(bundlePath)).size
  const addonPackages = await resolveAddonPackages(addonParents)
  addonPackagesByWorklet[worklet] = addonPackages
  if (worklet === 'sync' && addonPackages.length === 0) {
    throw new Error('Real Sync bundle did not resolve any native addons')
  }
  if (addonPackages.length > 0) {
    console.log(`${worklet} linked addons: ${addonPackages.join(', ')}`)
  }
}

const measurements = {
  generatedAt: new Date().toISOString(),
  bundleBytes,
  nativeBinaryBytes: null,
  note: 'Native binary size requires a physical-device release build.'
}
await writeFile(
  fileURLToPath(
    new URL('../generated/build-measurements.json', import.meta.url).href
  ),
  `${JSON.stringify(measurements, null, 2)}\n`
)
await writeFile(
  fileURLToPath(
    new URL('../generated/native-addons.json', import.meta.url).href
  ),
  `${JSON.stringify(
    {
      worklets: addonPackagesByWorklet,
      packages: [...new Set(Object.values(addonPackagesByWorklet).flat())].sort()
    },
    null,
    2
  )}\n`
)

console.log(`worklet artifacts written to ${generated}`)

interface WorkletImport {
  readonly type: number
  readonly specifier: string
}

interface WorkletResolveOptions {
  readonly linked?: boolean
  readonly hosts?: readonly string[]
  readonly onAddon?: (parentURL: BareURL) => void
  readonly [key: string]: unknown
}

function resolveWorklet(
  entry: WorkletImport,
  parentURL: BareURL,
  options: WorkletResolveOptions = {}
) {
  const linked = options.linked ?? false
  const hosts = options.hosts ?? workletHosts
  let extensions: string[] | undefined
  let conditions = hosts.map((host) => ['bare', 'node', ...host.split('-')])

  if (entry.type & lex.constants.ADDON) {
    if (entry.type & lex.constants.DYNAMIC) {
      throw new Error(
        `Dynamic native addon loading is not supported from ${parentURL.href}`
      )
    }
    options.onAddon?.(parentURL)
    extensions = linked ? [] : ['.bare', '.node']
    conditions = conditions.map((condition) => ['addon', ...condition])
    return resolverApis().addon(entry.specifier || '.', parentURL, {
      ...options,
      extensions,
      conditions,
      hosts,
      linked
    })
  }

  if (entry.type & lex.constants.ASSET) {
    conditions = conditions.map((condition) => ['asset', ...condition])
  } else {
    extensions = [
      '.js',
      '.cjs',
      '.mjs',
      '.ts',
      '.cts',
      '.mts',
      '.json',
      '.bare',
      '.node'
    ]
    if (entry.type & lex.constants.REQUIRE) {
      conditions = conditions.map((condition) => ['require', ...condition])
    } else if (entry.type & lex.constants.IMPORT) {
      conditions = conditions.map((condition) => ['import', ...condition])
    }
  }

  return resolverApis().module(entry.specifier, parentURL, {
    ...options,
    extensions,
    conditions
  })
}

function resolverApis() {
  return (
    traverse as unknown as {
      readonly resolve: {
        addon(
          specifier: string,
          parentURL: BareURL,
          options: Record<string, unknown>
        ): unknown
        module(
          specifier: string,
          parentURL: BareURL,
          options: Record<string, unknown>
        ): unknown
      }
    }
  ).resolve
}

async function resolveAddonPackages(parents: ReadonlySet<string>) {
  const packages = new Set<string>()
  for (const parent of parents) {
    packages.add(await findAddonPackage(parent))
  }
  return [...packages].sort()
}

async function findAddonPackage(parent: string) {
  let directory = path.dirname(fileURLToPath(parent))
  while (true) {
    const packagePath = path.join(directory, 'package.json')
    try {
      const parsed: unknown = JSON.parse(await readFile(packagePath, 'utf8'))
      if (
        typeof parsed === 'object' &&
        parsed !== null &&
        'addon' in parsed &&
        parsed.addon === true &&
        'name' in parsed &&
        typeof parsed.name === 'string'
      ) {
        return parsed.name
      }
    } catch (error) {
      if (!isMissing(error)) throw error
    }
    const next = path.dirname(directory)
    if (next === directory) break
    directory = next
  }
  throw new Error(`Could not identify native addon package for ${parent}`)
}

function isMissing(error: unknown) {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    error.code === 'ENOENT'
  )
}
