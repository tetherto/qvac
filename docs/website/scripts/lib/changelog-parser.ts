import { existsSync, readFileSync } from "fs";
import { join } from "path";

export const CATEGORY_MAP: Record<string, string> = {
  "breaking changes": "Breaking Changes",
  "new apis": "Features",
  "api": "API",
  "api changes": "API",
  "bug fixes": "Bug Fixes",
  "fixes": "Bug Fixes",
  "fixed": "Bug Fixes",
  "models": "Models",
  "documentation": "Documentation",
  "docs": "Documentation",
  "testing": "Testing",
  "tests": "Testing",
  "chores": "Chores",
  "infrastructure": "Infrastructure",
  "changed": "Changed",
  "added": "Added",
  "features": "Features",
  "removed": "Removed",
  "deprecated": "Deprecated",
  "security": "Security",
};

export const CATEGORY_ORDER = [
  "Breaking Changes",
  "Features",
  "API",
  "Changed",
  "Added",
  "Bug Fixes",
  "Models",
  "Documentation",
  "Testing",
  "Chores",
  "Infrastructure",
  "Removed",
  "Deprecated",
  "Security",
];

export interface ParsedSection {
  category: string;
  content: string;
}

export interface PackageChangelog {
  pkg: string;
  preamble: string;
  sections: ParsedSection[];
}

export interface MergedCategory {
  name: string;
  packages: Array<{ pkg: string; content: string }>;
}

export interface OverrideSection {
  heading: string;
  content: string;
}

export function stripEmoji(text: string): string {
  return text
    .replace(/[\p{Emoji_Presentation}\p{Extended_Pictographic}\uFE0E\uFE0F]/gu, "")
    .trim();
}

export function normalizeCategory(heading: string): string {
  const stripped = stripEmoji(heading);
  const lower = stripped.toLowerCase();
  return CATEGORY_MAP[lower] ?? stripped;
}

export function isKnownCategory(heading: string): boolean {
  const stripped = stripEmoji(heading);
  return stripped.toLowerCase() in CATEGORY_MAP;
}

export function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function extractVersionBlock(
  content: string,
  version: string
): string | null {
  const pattern = new RegExp(
    `^## \\[${escapeRegExp(version)}\\].*$`,
    "m"
  );
  const match = pattern.exec(content);
  if (!match) return null;

  const start = match.index + match[0].length;
  const rest = content.slice(start);
  const nextVersion = /^## \[/m.exec(rest);
  const block = nextVersion ? rest.slice(0, nextVersion.index) : rest;

  return block.trim();
}

export function parseVersionBlock(block: string): {
  preamble: string;
  sections: ParsedSection[];
} {
  const lines = block.split("\n");
  const sections: ParsedSection[] = [];
  let preamble = "";
  let currentHeading: string | null = null;
  let currentLines: string[] = [];

  const sectionRe = /^#{2,3}\s+(.+)$/;

  function flush() {
    if (currentHeading === null) return;
    const content = currentLines.join("\n").trim();
    if (content) {
      sections.push({ category: normalizeCategory(currentHeading), content });
    }
  }

  for (const line of lines) {
    const headingMatch = sectionRe.exec(line);
    if (headingMatch) {
      const text = headingMatch[1].trim();
      if (/^\[?\d+\.\d+/.test(text)) continue;

      if (isKnownCategory(text)) {
        flush();
        currentHeading = text;
        currentLines = [];
      } else if (currentHeading !== null) {
        currentLines.push(line);
      } else {
        preamble += line + "\n";
      }
    } else if (currentHeading !== null) {
      currentLines.push(line);
    } else {
      preamble += line + "\n";
    }
  }

  flush();

  preamble = preamble.replace(/^---\s*$/gm, "").trim();

  for (const section of sections) {
    section.content = section.content.replace(/\n---\s*$/g, "").trim();
  }

  return { preamble, sections };
}

export function mergeChangelogs(changelogs: PackageChangelog[]): MergedCategory[] {
  const map = new Map<string, Array<{ pkg: string; content: string }>>();

  for (const cl of changelogs) {
    for (const section of cl.sections) {
      if (!map.has(section.category)) {
        map.set(section.category, []);
      }
      map.get(section.category)!.push({
        pkg: cl.pkg,
        content: section.content,
      });
    }
  }

  const ordered: MergedCategory[] = [];
  for (const name of CATEGORY_ORDER) {
    const pkgs = map.get(name);
    if (pkgs && pkgs.length > 0) {
      ordered.push({ name, packages: pkgs });
      map.delete(name);
    }
  }

  const remaining = [...map.entries()].sort((a, b) =>
    a[0].localeCompare(b[0])
  );
  for (const [name, pkgs] of remaining) {
    if (pkgs.length > 0) {
      ordered.push({ name, packages: pkgs });
    }
  }

  return ordered;
}

/**
 * Read a polished per-version changelog folder (Fonte B) and turn it into
 * the same `PackageChangelog` shape that `parseChangelog` produces from the
 * aggregated root CHANGELOG.md (Fonte A).
 *
 * Folder layout under `packages/<pkg>/changelog/<version>/`:
 *   - `CHANGELOG_LLM.md` — human + LLM curated copy, preferred.
 *   - `CHANGELOG.md`     — raw fallback, used only when `CHANGELOG_LLM.md`
 *                          is missing (e.g. when the `/sdk-changelog` skill
 *                          hasn't been run yet).
 *
 * The H1 heading is conventionally `# QVAC SDK v<X.Y.Z> Release Notes` and
 * is stripped before delegating to `parseVersionBlock`, which already knows
 * how to interpret the rest (preamble + `##` / `###` category sections).
 *
 * Returns `null` when neither file exists.
 */
export function parseChangelogFolder(
  folderPath: string,
  pkg: string,
): PackageChangelog | null {
  const llmPath = join(folderPath, "CHANGELOG_LLM.md");
  const rawPath = join(folderPath, "CHANGELOG.md");
  let content: string;
  if (existsSync(llmPath)) {
    content = readFileSync(llmPath, "utf-8");
  } else if (existsSync(rawPath)) {
    content = readFileSync(rawPath, "utf-8");
  } else {
    return null;
  }

  // Strip the H1 `# QVAC SDK v<X.Y.Z> Release Notes` heading (if present)
  // so `parseVersionBlock` doesn't promote it into the preamble. Only the
  // first H1 is removed; subsequent ones (rare) are preserved as body.
  // Allowing any trailing label (e.g. "Release Notes", "Hotfix Release")
  // — we only anchor on the `QVAC SDK v…` prefix.
  const stripped = content.replace(
    /^#\s+QVAC\s+SDK\s+v\d+\.\d+\.\d+[^\n]*\n+/,
    "",
  );

  const { preamble, sections } = parseVersionBlock(stripped);
  return { pkg, preamble, sections };
}

/**
 * A package's `CHANGELOG_LLM.md` (or fallback `CHANGELOG.md`) body, with
 * the leading `# QVAC SDK v… Release Notes` H1 stripped and every
 * surviving heading demoted by `shiftBy` levels.
 *
 * Used by the per-version verbatim release-notes renderer: each pod
 * package's body is inlined under a `### @qvac/<pkg>` subsection, so the
 * source's `## Breaking Changes` heading becomes `##### Breaking Changes`
 * (h2 → h2 + shiftBy levels) and won't collide with the page's outer
 * `## vX.Y.Z` / `### @qvac/<pkg>` hierarchy.
 *
 * Headings beyond the markdown limit (h6) clamp at h6 — Fumadocs renders
 * them as plain bold text either way.
 */
export interface VerbatimChangelog {
  pkg: string;
  body: string;
}

/**
 * Demote every ATX heading (`#`, `##`, ...) in the markdown source by
 * `shiftBy` levels, clamping at h6. Code-fenced blocks (``` and ~~~)
 * are preserved verbatim because a `#` inside them is shell-comment
 * syntax, not markdown.
 *
 * Setext underlines (`===` / `---`) are left alone — they're rare in
 * machine-generated changelogs and a setext H1 inside fenced code would
 * be a code construct anyway. If a `CHANGELOG_LLM.md` ever uses one,
 * we'll cross that bridge then.
 *
 * Exported for unit testing.
 */
export function shiftHeadings(source: string, shiftBy: number): string {
  if (shiftBy <= 0) return source;
  const lines = source.split("\n");
  const fenceRe = /^(?:```|~~~)/;
  let inFence = false;
  for (let i = 0; i < lines.length; i++) {
    if (fenceRe.test(lines[i].trimStart())) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    const m = /^(#{1,6})(\s.*)$/.exec(lines[i]);
    if (!m) continue;
    const newLevel = Math.min(6, m[1].length + shiftBy);
    lines[i] = "#".repeat(newLevel) + m[2];
  }
  return lines.join("\n");
}

/**
 * Read a polished per-version changelog folder (Fonte B) and return its
 * body verbatim — H1 stripped, headings shifted to nest under the
 * per-version page hierarchy.
 *
 * Folder layout under `packages/<pkg>/changelog/<version>/`:
 *   - `CHANGELOG_LLM.md` — preferred (human + LLM curated).
 *   - `CHANGELOG.md`     — fallback when the LLM-curated copy hasn't
 *                          landed yet.
 *
 * Returns `null` when neither file exists. Trailing whitespace is
 * trimmed so caller concatenation doesn't accumulate blank lines.
 */
export function readChangelogLLMVerbatim(
  folderPath: string,
  pkg: string,
  shiftBy = 2,
): VerbatimChangelog | null {
  const llmPath = join(folderPath, "CHANGELOG_LLM.md");
  const rawPath = join(folderPath, "CHANGELOG.md");
  let content: string;
  if (existsSync(llmPath)) {
    content = readFileSync(llmPath, "utf-8");
  } else if (existsSync(rawPath)) {
    content = readFileSync(rawPath, "utf-8");
  } else {
    return null;
  }

  // Strip the conventional H1 `# QVAC SDK v<X.Y.Z> [— …]` heading (and any
  // immediately-following blank lines) before shifting. Anchor on the
  // `QVAC SDK v…` prefix so we don't accidentally clobber a body H1 in
  // future formats (rare — the format guide keeps H1 reserved for the
  // version banner). When the file falls back to raw `CHANGELOG.md`, no
  // such header exists and this regex is a no-op.
  const stripped = content.replace(
    /^#\s+QVAC\s+SDK\s+v\d+\.\d+\.\d+[^\n]*\n+/,
    "",
  );

  const shifted = shiftHeadings(stripped, shiftBy);
  return { pkg, body: shifted.replace(/\s+$/g, "") };
}

export function parseOverridesContent(content: string): OverrideSection[] {
  const lines = content.split("\n");
  const sections: OverrideSection[] = [];
  let heading: string | null = null;
  let buffer: string[] = [];

  const headingRe = /^##\s+(.+)$/;

  function flush() {
    if (heading === null) return;
    const trimmed = buffer.join("\n").trim();
    if (trimmed) {
      sections.push({ heading, content: trimmed });
    }
  }

  for (const line of lines) {
    const match = headingRe.exec(line);
    if (match) {
      flush();
      heading = match[1].trim();
      buffer = [];
    } else if (heading !== null) {
      buffer.push(line);
    }
  }

  flush();
  return sections;
}
