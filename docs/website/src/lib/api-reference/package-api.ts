/**
 * The API reference of a package documented inside Ecosystem, as its
 * normalizer writes it (`_generated/api.json`, written by
 * `scripts/api-reference/generate-package-api.ts`), and its Markdown
 * rendition for the page's Markdown twin.
 */

export interface PackageApiField {
  name: string
  type: string
  optional: boolean
  description: string
}

export interface PackageApiSignature {
  text: string
  parameters: PackageApiField[]
  returns: { type: string; description: string }
}

export interface PackageApiExport {
  name: string
  kind: 'function' | 'class' | 'interface' | 'type' | 'variable' | 'enum'
  summary: string
  deprecated: string | null
  signatures?: PackageApiSignature[]
  fields?: PackageApiField[]
  values?: string[]
  type?: string
  methods?: { name: string; signatures: PackageApiSignature[] }[]
  source: string | null
}

export interface PackageApi {
  package: string
  exports: PackageApiExport[]
}

/** The order exports are grouped in, with each group's heading. */
export const EXPORT_GROUPS: ReadonlyArray<[PackageApiExport['kind'], string]> = [
  ['function', 'Functions'],
  ['class', 'Classes'],
  ['interface', 'Interfaces'],
  ['type', 'Types'],
  ['enum', 'Enums'],
  ['variable', 'Constants'],
]

/** The anchor an export's heading carries, so a type naming it can link there. */
export function exportAnchor(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '-')
}

function fieldsAsMarkdown(fields: PackageApiField[]): string {
  return fields
    .map((field) => `- \`${field.name}${field.optional ? '?' : ''}: ${field.type}\`${field.description ? ` — ${field.description}` : ''}`)
    .join('\n')
}

function signatureAsMarkdown(signature: PackageApiSignature): string {
  const lines = [`\`\`\`ts\n${signature.text}\n\`\`\``]
  if (signature.parameters.length > 0) lines.push(fieldsAsMarkdown(signature.parameters))
  if (signature.returns.description) lines.push(`Returns \`${signature.returns.type}\`: ${signature.returns.description}`)
  return lines.join('\n\n')
}

function exportAsMarkdown(entry: PackageApiExport): string {
  const parts = [`### \`${entry.name}\``]
  if (entry.deprecated) parts.push(`> **Deprecated:** ${entry.deprecated}`)
  if (entry.summary) parts.push(entry.summary)
  for (const signature of entry.signatures ?? []) parts.push(signatureAsMarkdown(signature))
  if (entry.fields?.length) parts.push(fieldsAsMarkdown(entry.fields))
  for (const method of entry.methods ?? []) {
    parts.push(`#### \`${method.name}()\``, ...method.signatures.map(signatureAsMarkdown))
  }
  if (entry.values?.length) parts.push(entry.values.map((value) => `- \`${value}\``).join('\n'))
  if (entry.type) parts.push(`\`\`\`ts\ntype ${entry.name} = ${entry.type}\n\`\`\``)
  return parts.join('\n\n')
}

export function packageApiAsMarkdown(api: PackageApi): string {
  return EXPORT_GROUPS.flatMap(([kind, heading]) => {
    const entries = api.exports.filter((entry) => entry.kind === kind)
    return entries.length > 0 ? [`## ${heading}`, ...entries.map(exportAsMarkdown)] : []
  }).join('\n\n')
}
