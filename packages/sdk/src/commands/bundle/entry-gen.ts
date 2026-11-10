import { parseBuiltinSpecifier } from '@/commands/bundle/plugins'

export function generateWorkerEntry(
  pluginSpecifiers: string[],
  sdkName: string,
  rpcServerProvider?: string,
  resolveImport: (specifier: string) => string = (specifier) => specifier
): string {
  const from = (specifier: string) => JSON.stringify(resolveImport(specifier))
  const imports = [`import { startWorker } from ${from(`${sdkName}/worker`)}`]
  const plugins: string[] = []

  for (const specifier of pluginSpecifiers) {
    const builtin = parseBuiltinSpecifier(specifier, sdkName)
    const name = builtin ? builtin.exportName : `customPlugin${plugins.length}`
    imports.push(
      builtin
        ? `import { ${name} } from ${from(specifier)}`
        : `import ${name} from ${from(specifier)}`
    )
    plugins.push(name)
  }

  const options = [`plugins: [${plugins.join(', ')}]`]
  if (rpcServerProvider) {
    imports.push(`import rpcServerProvider from ${from(rpcServerProvider)}`)
    options.push('rpcServerProvider')
  }

  return `${imports.join('\n')}

export default function start(ipc, ready) {
  return startWorker(ipc, ready, { ${options.join(', ')} })
}
`
}
