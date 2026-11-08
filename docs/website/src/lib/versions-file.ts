// Relative imports only: this module is part of `source.config.ts`'s import
// graph, which the MDX config loader resolves outside the Next path aliases.
import { z } from 'zod'

/**
 * The shape of one file under `docs/website/versions/`: one documented
 * software, the paths that make up a line of it, and every line it publishes,
 * each pinned to the commit it documents.
 *
 * Line order states currency: the first line is the current one. Nothing else
 * marks it, so promoting a line is moving its entry to the top.
 */

/** A documentation line: major and minor, never a patch. */
export const LINE_VERSION = /^v\d+\.\d+$/

const lineVersion = z
  .string()
  .regex(LINE_VERSION, 'a line is `v<major>.<minor>`, never a patch')

/**
 * A line rendered from a pinned commit: `ref` names what it follows (a
 * release branch or tag) and `sha` is the commit materialized.
 */
const pinnedLine = z
  .object({
    version: lineVersion,
    ref: z.string().min(1),
    sha: z.string().regex(/^[0-9a-f]{7,40}$/, 'a commit is a hex SHA'),
  })
  .strict()

/**
 * A line still held in place under `content/docs/`, from before the software
 * moved its documentation into its package. Transitional: the package
 * migration replaces every such line with pinned ones.
 */
const inPlaceLine = z
  .object({
    version: lineVersion,
    inPlace: z.literal(true),
  })
  .strict()

export const versionsLineSchema = z.union([pinnedLine, inPlaceLine])

export const versionsFileSchema = z
  .object({
    /** The name the package publishes under, in its own registry. */
    package: z.string().min(1),
    /**
     * `product` — software a developer uses directly, with its own
     * versioned root collection. `platform` — a package the products are
     * built on, documented as a sub-collection of
     * Ecosystem → Packages. The kind decides where the software appears,
     * whether one line is current, what the docs contract requires, and how
     * strictly pages bind to its API.
     */
    kind: z.enum(['product', 'platform']),
    /** Where it is documented, absolute and without a trailing slash. */
    path: z.string().regex(/^(\/[a-z0-9-]+)+$/, 'an absolute path without a trailing slash'),
    /** Another repository (`owner/name`), for software outside the monorepo. */
    repo: z.string().regex(/^[\w.-]+\/[\w.-]+$/).nullable().default(null),
    /**
     * Repository-relative paths that make up a line. The first is the
     * documentation root, published as the line's page tree; the rest
     * (examples, generated contracts) are extracted beside it.
     */
    paths: z.array(z.string().min(1)).min(1),
    /**
     * Versions no longer published, retired by hand: moving a version from
     * `lines` to here unpublishes it and redirects its addresses to the
     * current line.
     */
    retired: z.array(lineVersion).default([]),
    lines: z.array(versionsLineSchema).min(1),
  })
  .strict()
  .superRefine((file, ctx) => {
    const versions = file.lines.map((line) => line.version)
    const seen = new Set<string>()
    versions.forEach((version, index) => {
      if (seen.has(version)) {
        ctx.addIssue({ code: 'custom', path: ['lines', index], message: `${version} is declared twice` })
      }
      seen.add(version)
      if (file.retired.includes(version)) {
        ctx.addIssue({ code: 'custom', path: ['lines', index], message: `${version} is both published and retired` })
      }
    })
    for (let index = 1; index < versions.length; index++) {
      if (compareLineVersions(versions[index - 1], versions[index]) <= 0) {
        ctx.addIssue({
          code: 'custom',
          path: ['lines', index],
          message: `lines are declared newest first: ${versions[index]} cannot follow ${versions[index - 1]}`,
        })
      }
    }
  })

export type VersionsFile = z.infer<typeof versionsFileSchema>
export type VersionsLine = z.infer<typeof versionsLineSchema>

export function isPinnedLine(line: VersionsLine): line is z.infer<typeof pinnedLine> {
  return 'sha' in line
}

/** Orders `vA.B` against `vC.D` numerically: negative when `a` is older. */
export function compareLineVersions(a: string, b: string): number {
  const [aMajor, aMinor] = a.slice(1).split('.').map(Number)
  const [bMajor, bMinor] = b.slice(1).split('.').map(Number)
  return aMajor - bMajor || aMinor - bMinor
}

/**
 * Parses one versions file, naming the file in every error so the build
 * points at the software that is malformed.
 */
export function parseVersionsFile(name: string, raw: unknown): VersionsFile {
  const result = versionsFileSchema.safeParse(raw)
  if (!result.success) {
    const issues = result.error.issues
      .map((issue) => `  - ${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('\n')
    throw new Error(`versions/${name} is malformed:\n${issues}`)
  }
  return result.data
}
