/**
 * Renders a page's data components as Markdown, for the page's Markdown twin
 * and the corpora built from it. In HTML these components draw tables; in
 * Markdown they become the card form an agent reads best — a TypeScript type
 * for fields, a list for models, the full card for a function — read from the
 * same line data, so both renditions state the same facts.
 */
import { functionCard, modelsAsMarkdown, modelsForEngines, shapeAsTypeScript } from './card'
import { functionNames, functionReference, lineApiForUrl } from './data'

const TAG = /<(FunctionReference|SchemaTable|ModelsTable|FunctionIndex|LanguageSwitch)\b([^>]*?)\/>/g

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
