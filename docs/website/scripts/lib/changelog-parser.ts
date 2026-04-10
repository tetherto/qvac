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
