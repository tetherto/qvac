/**
 * The TypeDoc normalizer: a package's public declarations, as TypeDoc resolved
 * them, in the shape the site renders (`_generated/api.json`).
 *
 * It formats and interprets nothing. Interfaces and object type aliases are
 * expanded into their fields, literal unions and enums into their values,
 * and overloads into one signature each. Every type is TypeDoc's own type
 * text.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import * as path from 'node:path'
import ts from 'typescript'
import { Application, ReflectionKind, type Comment, type DeclarationReflection, type ProjectReflection, type SignatureReflection, type SomeType } from 'typedoc'
import type { PackageApi, PackageApiExport, PackageApiField, PackageApiSignature } from '../../src/lib/api-reference/package-api'

type PackageApiExportKind = PackageApiExport['kind']

const KINDS = new Map<ReflectionKind, PackageApiExportKind>([
  [ReflectionKind.Function, 'function'],
  [ReflectionKind.Class, 'class'],
  [ReflectionKind.Interface, 'interface'],
  [ReflectionKind.TypeAlias, 'type'],
  [ReflectionKind.Variable, 'variable'],
  [ReflectionKind.Enum, 'enum'],
])

/** Comment text, with an inline tag such as `{@link translate}` written as its target in code. */
function text(parts: readonly { kind: string; text: string }[] | undefined): string {
  if (!parts) return ''
  return parts
    .map((part) => (part.kind === 'inline-tag' ? `\`${part.text}\`` : part.text))
    .join('')
    .trim()
}

function summaryOf(reflection: { comment?: Comment }): string {
  return text(reflection.comment?.summary)
}

function deprecatedOf(reflection: { comment?: Comment }): string | null {
  const tag = reflection.comment?.getTag('@deprecated')
  return tag ? text(tag.content) || 'Deprecated.' : null
}

function typeText(type: SomeType | undefined): string {
  return type ? type.toString() : 'unknown'
}

function field(reflection: DeclarationReflection): PackageApiField {
  const signature = reflection.signatures?.[0]
  return {
    name: reflection.name,
    type: signature ? signatureText(signature, '') : typeText(reflection.type),
    optional: reflection.flags.isOptional,
    description: summaryOf(reflection) || (signature ? summaryOf(signature) : ''),
  }
}

function signatureText(signature: SignatureReflection, name: string): string {
  const parameters = (signature.parameters ?? [])
    .map((parameter) => `${parameter.flags.isRest ? '...' : ''}${parameter.name}${parameter.flags.isOptional || parameter.defaultValue ? '?' : ''}: ${typeText(parameter.type)}`)
    .join(', ')
  const generics = signature.typeParameters?.length ? `<${signature.typeParameters.map((parameter) => parameter.name).join(', ')}>` : ''
  return `${name}${generics}(${parameters}): ${typeText(signature.type)}`
}

function signature(reflection: SignatureReflection, name: string): PackageApiSignature {
  return {
    text: signatureText(reflection, name),
    parameters: (reflection.parameters ?? []).map((parameter) => ({
      name: parameter.name,
      type: typeText(parameter.type),
      optional: parameter.flags.isOptional || parameter.defaultValue !== undefined,
      description: summaryOf(parameter),
    })),
    returns: { type: typeText(reflection.type), description: text(reflection.comment?.getTag('@returns')?.content) },
  }
}

function sourceOf(reflection: DeclarationReflection, packageDir: string): string | null {
  const source = reflection.sources?.[0]
  if (!source) return null
  const file = path.isAbsolute(source.fullFileName) ? path.relative(packageDir, source.fullFileName) : source.fileName
  return `${file.split(path.sep).join('/')}:${source.line}`
}

/** A union whose every member is a literal, as its values; otherwise null. */
function literalValues(type: SomeType | undefined): string[] | null {
  if (type?.type !== 'union') return null
  const values = type.types.map((member) => (member.type === 'literal' ? member.toString() : null))
  return values.every((value): value is string => value !== null) ? values : null
}

function normalize(reflection: DeclarationReflection, packageDir: string): PackageApiExport | null {
  const kind = KINDS.get(reflection.kind)
  if (!kind) return null
  const base: PackageApiExport = {
    // A CommonJS `export =` is named after what it exports, not `export=`.
    name: reflection.name === 'export=' ? String((reflection as { escapedName?: string }).escapedName ?? reflection.name) : reflection.name,
    kind,
    summary: summaryOf(reflection) || summaryOf(reflection.signatures?.[0] ?? {}),
    deprecated: deprecatedOf(reflection) ?? deprecatedOf(reflection.signatures?.[0] ?? {}),
    source: sourceOf(reflection, packageDir),
  }
  const members = [...(reflection.children ?? [])].sort((a, b) => a.name.localeCompare(b.name))
  switch (kind) {
    case 'function':
      return { ...base, signatures: (reflection.signatures ?? []).map((entry) => signature(entry, reflection.name)) }
    case 'interface':
      return { ...base, fields: members.map(field) }
    case 'class': {
      const constructor = members.find((member) => member.kind === ReflectionKind.Constructor)
      return {
        ...base,
        signatures: (constructor?.signatures ?? []).map((entry) => signature(entry, `new ${reflection.name}`)),
        fields: members.filter((member) => member.kind === ReflectionKind.Property || member.kind === ReflectionKind.Accessor).map(field),
        methods: members
          .filter((member) => member.kind === ReflectionKind.Method)
          .map((member) => ({ name: member.name, signatures: (member.signatures ?? []).map((entry) => signature(entry, member.name)) })),
      }
    }
    case 'enum':
      return { ...base, values: members.map((member) => `${member.name} = ${typeText(member.type)}`) }
    case 'type': {
      // TypeDoc converts an object type alias like an interface, onto the
      // alias's own children; older versions kept them on a reflection type.
      if (members.length > 0) return { ...base, fields: members.map(field) }
      const declaration = reflection.type?.type === 'reflection' ? reflection.type.declaration : null
      if (declaration?.children) {
        return { ...base, fields: [...declaration.children].sort((a, b) => a.name.localeCompare(b.name)).map(field) }
      }
      if (declaration?.signatures) {
        return { ...base, signatures: declaration.signatures.map((entry) => signature(entry, reflection.name)) }
      }
      const values = literalValues(reflection.type)
      return values ? { ...base, values } : { ...base, type: typeText(reflection.type) }
    }
    case 'variable':
      return { ...base, type: typeText(reflection.type) }
  }
}

/** The normalized public surface of a converted TypeDoc project. */
export function normalizeProject(project: ProjectReflection, packageName: string, packageDir: string): PackageApi {
  const exports = (project.children ?? [])
    .map((reflection) => normalize(reflection, packageDir))
    .filter((entry): entry is PackageApiExport => entry !== null)
    .sort((a, b) => a.name.localeCompare(b.name) || a.kind.localeCompare(b.kind))
  return { package: packageName, exports }
}

/** The compiler options a `tsconfig.json` declares, `extends` resolved. */
function compilerOptionsOf(tsconfig: string): Record<string, unknown> {
  const read = ts.readConfigFile(tsconfig, ts.sys.readFile)
  if (read.error) return {}
  const { outDir: _outDir, rootDir: _rootDir, ...options } = (read.config as { compilerOptions?: Record<string, unknown> }).compilerOptions ?? {}
  return options
}

/**
 * Converts a package's public entry with TypeDoc and normalizes it. The
 * package's own `tsconfig.json` is used when it has one, so its dependencies
 * resolve as they do for the package.
 */
export async function packageApi(packageDir: string, entry: string, packageName: string, tsconfig: string | null): Promise<PackageApi> {
  // A tsconfig of its own, listing exactly the entry: TypeDoc otherwise reads
  // the tsconfig of the directory it runs in, and the package's own usually
  // includes its sources rather than its public declarations. The package's
  // compiler options carry over, so its dependencies resolve as they do for it.
  const entryFile = path.join(packageDir, entry)
  const scratch = mkdtempSync(path.join(tmpdir(), 'package-api-'))
  const config = path.join(scratch, 'tsconfig.json')
  writeFileSync(
    config,
    JSON.stringify({
      compilerOptions: { skipLibCheck: true, strict: true, ...(tsconfig ? compilerOptionsOf(tsconfig) : {}), noEmit: true },
      files: [entryFile],
    }),
  )
  try {
    return await convert(entryFile, config, packageName, packageDir)
  } finally {
    rmSync(scratch, { recursive: true, force: true })
  }
}

async function convert(entryFile: string, tsconfig: string, packageName: string, packageDir: string): Promise<PackageApi> {
  const app = await Application.bootstrap({
    entryPoints: [entryFile],
    tsconfig,
    excludePrivate: true,
    excludeProtected: true,
    excludeExternals: true,
    excludeInternal: true,
    skipErrorChecking: true,
    // Source links are not used, so TypeDoc's warning about the git remote is noise.
    logLevel: 'Error',
  })
  const project = await app.convert()
  if (!project) throw new Error(`TypeDoc could not convert ${entryFile}`)
  return normalizeProject(project, packageName, packageDir)
}
