import bundleId from 'bare-bundle-id'
import lex from 'bare-module-lexer'
import traverse from 'bare-module-traverse'
import pack from 'bare-pack'
import { listPrefix, readModule } from 'bare-pack/fs'
import strip from 'bare-type-stripper'
import { mkdir, rm, stat, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import {
  generateWorkletHarness,
  workletHosts
} from './react-native-worklet-target'

type BareURL = import('bare-url')

const appRoot = new URL('../', import.meta.url) as unknown as BareURL
const generated = fileURLToPath(new URL('../generated/', import.meta.url).href)
const worklets = ['sync', 'harness', 'sdk'] as const

await rm(generated, { recursive: true, force: true })
await mkdir(generated, { recursive: true })

const bundleBytes: Record<string, number> = {}
for (const worklet of worklets) {
  const entry = new URL(
    `../worklets/__mobile-${worklet}.mjs`,
    import.meta.url
  ) as unknown as BareURL
  const entrySource = `\
import start from './${worklet}.ts'

await start(BareKit.IPC)
`
  const bundle = await pack(
    entry,
    {
      base: appRoot,
      hosts: workletHosts,
      linked: worklet === 'sdk',
      offload: false,
      resolve: resolveWorklet as NonNullable<
        import('bare-pack').PackOptions['resolve']
      >,
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

console.log(`worklet artifacts written to ${generated}`)

interface WorkletImport {
  readonly type: number
  readonly specifier: string
}

interface WorkletResolveOptions {
  readonly linked?: boolean
  readonly hosts?: readonly string[]
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
