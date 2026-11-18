/**
 * The Markdown renditions of the API data: a function's card, a field table
 * written as a TypeScript type, and a model list. They are what a page's
 * Markdown twin carries where its HTML renders tables, so an agent reading
 * the twin gets the same facts in the form it reads best.
 */
import type { FunctionReference, LineApi, ModelEntry } from './data'
import type { Field, Shape } from './schema'

const INDENT = '  '

function comment(field: Field): string {
  const parts = [field.description?.replace(/\s+/g, ' ').trim().replace(/\.$/, ''), ...field.constraints]
  if (field.default !== undefined) parts.push(`default ${field.default}`)
  const text = parts.filter(Boolean).join('; ')
  return text ? ` // ${text}` : ''
}

/** A shape written as a TypeScript type, nested objects expanded inline. */
export function shapeAsTypeScript(shape: Shape, depth = 0): string {
  const pad = INDENT.repeat(depth)
  if (shape.kind === 'variants') {
    return shape.variants
      .map((variant) => `${pad}| // ${variant.label}\n${shapeAsTypeScript(variant.shape, depth + 1)}`)
      .join('\n')
  }
  const lines = shape.fields.map((field) => {
    const name = `${field.name}${field.required ? '' : '?'}`
    if (field.shape) {
      const array = field.type.endsWith('[]') ? '[]' : ''
      return `${pad}${INDENT}${name}:${comment(field)}\n${shapeAsTypeScript(field.shape, depth + 2)}${array}`
    }
    return `${pad}${INDENT}${name}: ${field.type}${comment(field)}`
  })
  return `${pad}{\n${lines.join('\n')}\n${pad}}`
}

export function functionCard(reference: FunctionReference): string {
  const sections: string[] = []
  if (reference.deprecated) sections.push(`> **Deprecated:** ${reference.deprecated}`)
  if (reference.description) sections.push(reference.description.trim())

  const signatures = ['```ts', reference.jsSignature, '```']
  if (reference.pythonSignature) signatures.push('', '```python', reference.pythonSignature, '```')
  sections.push(`## Signature\n\n${signatures.join('\n')}`)

  if (reference.request) {
    sections.push(`## Parameters\n\n\`\`\`ts\ntype Request =\n${shapeAsTypeScript(reference.request)}\n\`\`\``)
  }
  if (reference.returnFields.length > 0) {
    const fields = reference.returnFields.map((field) => `- \`${field.name}${field.required ? '' : '?'}: ${field.type}\``)
    sections.push(`## Returns\n\n${fields.join('\n')}`)
  } else if (reference.returns) {
    sections.push(`## Returns\n\n\`${reference.returns}\``)
  }
  if (reference.throws.length > 0) {
    sections.push(`## Throws\n\n${reference.throws.map((entry) => `- \`${entry.error}\`: ${entry.description}`).join('\n')}`)
  }
  if (reference.target) {
    sections.push(`## Schema\n\nThe request and response JSON Schema: [\`${reference.name}.schema.json\`](./${reference.name}.schema.json)`)
  }
  return sections.join('\n\n')
}

/** The models a capability can load, as a Markdown list. */
export function modelsAsMarkdown(models: ModelEntry[]): string {
  if (models.length === 0) return '_No model constant is registered for this capability._'
  return models
    .map((model) => {
      const details = [model.engine, model.quantization, formatSize(model.expectedSize)].filter(Boolean).join(', ')
      return `- \`${model.name}\`${details ? ` (${details})` : ''}`
    })
    .join('\n')
}

export function modelsForEngines(api: LineApi, engines: readonly string[]): ModelEntry[] {
  const wanted = new Set(engines)
  return api.models
    .filter((model) => model.engine !== undefined && wanted.has(model.engine))
    .sort((a, b) => a.name.localeCompare(b.name))
}

export function formatSize(bytes: number | undefined): string | undefined {
  if (bytes === undefined || bytes <= 0) return undefined
  const units = ['B', 'KB', 'MB', 'GB']
  let value = bytes
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit++
  }
  return `${value.toFixed(value < 10 ? 1 : 0)} ${units[unit]}`
}
