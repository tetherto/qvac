/**
 * Renders a page's data components as Markdown, for the page's Markdown twin
 * and the corpora built from it. In HTML these components draw tables; in
 * Markdown they become the card form an agent reads best — a TypeScript type
 * for fields, a list for models, the full card for a function — read from the
 * same line data, so both renditions state the same facts.
 */
import { functionCard, modelsAsMarkdown, modelsForEngines, shapeAsTypeScript } from './card'
import { cliAsMarkdown, openApiAsMarkdown, type CliData } from './cli'
import { functionNames, functionReference, lineApiForUrl, lineGeneratedFile } from './data'
import { packageApiAsMarkdown, type PackageApi } from './package-api'

const TAG = /<(FunctionReference|SchemaTable|ModelsTable|FunctionIndex|LanguageSwitch|CliReference|OpenApiReference|PackageApiReference)\b([^>]*?)\/>/g

function attribute(attributes: string, name: string): string | null {
  return new RegExp(`${name}="([^"]*)"`).exec(attributes)?.[1] ?? null
}

function engines(attributes: string): string[] {
  const list = /engines=\{\s*\[([^\]]*)\]\s*\}/.exec(attributes)?.[1]
  if (!list) return []
  return JSON.parse(`[${list}]`) as string[]
}

export function renderDataComponentsAsMarkdown(text: string, url: string): string {
  if (!TAG.test(text)) return text
  TAG.lastIndex = 0
  const api = lineApiForUrl(url)
  return text.replace(TAG, (_match, component: string, attributes: string) => {
    if (component === 'LanguageSwitch') return ''
    if (component === 'CliReference') {
      const data = lineGeneratedFile<CliData>(url, 'cli.json')
      return data ? cliAsMarkdown(data, attribute(attributes, 'command') ?? undefined, /\btablesOnly\b/.test(attributes)) : '_Command reference data is not available for this documentation line._'
    }
    if (component === 'PackageApiReference') {
      const data = lineGeneratedFile<PackageApi>(url, 'api.json')
      return data ? packageApiAsMarkdown(data) : '_API reference data is not available for this documentation line._'
    }
    if (component === 'OpenApiReference') {
      const document = lineGeneratedFile<Record<string, unknown>>(url, 'openapi.json')
      return document ? openApiAsMarkdown(document) : '_HTTP API reference data is not available for this documentation line._'
    }
    if (!api) return '_API data is not available for this documentation line._'
    if (component === 'FunctionIndex') {
      return functionNames(api)
        .map((name) => `- [\`${name}\`](${api.base}/reference/api/${name}.md)`)
        .join('\n')
    }
    if (component === 'ModelsTable') return modelsAsMarkdown(modelsForEngines(api, engines(attributes)))
    const fn = attribute(attributes, 'fn')
    const reference = fn ? functionReference(api, fn) : null
    if (!reference) return `_\`${fn}\` is not a public function of this line._`
    if (component === 'FunctionReference') return functionCard(reference)
    return reference.request
      ? `\`\`\`ts\ntype Request =\n${shapeAsTypeScript(reference.request)}\n\`\`\``
      : `_No contract fields are published for \`${fn}\`._`
  })
}
