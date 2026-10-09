import { parseBuiltinSpecifier } from '@/commands/bundle/plugins'

export function generateWorkerEntry(
  pluginSpecifiers: string[],
  sdkName: string,
  rpcServerProvider?: string
): string {
  const imports = [`import { startWorker } from ${JSON.stringify(`${sdkName}/worker`)}`]
  const plugins: string[] = []

  for (const specifier of pluginSpecifiers) {
    const builtin = parseBuiltinSpecifier(specifier, sdkName)
    const name = builtin ? builtin.exportName : `customPlugin${plugins.length}`
    imports.push(
      builtin
        ? `import { ${name} } from ${JSON.stringify(specifier)}`
        : `import ${name} from ${JSON.stringify(specifier)}`
    )
    plugins.push(name)
  }

  const options = [`plugins: [${plugins.join(', ')}]`]
  if (rpcServerProvider) {
    imports.push(`import rpcServerProvider from ${JSON.stringify(rpcServerProvider)}`)
    options.push('rpcServerProvider')
  }

  return `${imports.join('\n')}

export default function start(ipc, ready) {
  return startWorker(ipc, ready, { ${options.join(', ')} })
}
`
}
