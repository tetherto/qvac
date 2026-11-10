/**
 * The API reference of a package documented inside Ecosystem, as its
 * normalizer writes it (`_generated/api.json`, written by
 * `scripts/api-reference/generate-package-api.ts`). The binding check
 * projects a package's surface from it; the reference page itself is
 * written by hand.
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
