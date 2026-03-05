import { readdir } from 'node:fs/promises';
import { join, relative } from 'node:path';

const ROOT = join(import.meta.dir, '..');
const CONTENT_DIR = join(ROOT, 'content', 'docs');
const SKIP_DIRS = new Set([
  '.latest-backup',
  'node_modules',
  '.source',
  '.next',
]);

const MD_LINK_RE = /\[(?:[^\]]*)\]\(([^)]+)\)/g;
const HREF_RE = /href=["']([^"']+)["']/g;

const GENERATED_PATH_RE = /^\/docs\/sdk\/api\/(latest|v\d)/;

interface BrokenLink {
  file: string;
  link: string;
  line: number;
}

async function collectMdxFiles(dir: string): Promise<string[]> {
  const files: string[] = [];
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return files;
  }

  for (const entry of entries) {
    if (SKIP_DIRS.has(entry.name)) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await collectMdxFiles(full)));
    } else if (entry.name.endsWith('.mdx')) {
      files.push(full);
    }
  }
  return files;
}

function buildRouteMap(files: string[]): Set<string> {
  const routes = new Set<string>();
  for (const file of files) {
    const route = relative(CONTENT_DIR, file)
      .replaceAll('\\', '/')
      .replace(/\.mdx$/, '')
      .replace(/\/index$/, '');

    routes.add(route === '' ? '/docs' : `/docs/${route}`);
  }
  return routes;
}

function isSkippable(link: string): boolean {
  if (!link) return true;
  if (link.startsWith('#')) return true;
  if (link.startsWith('http://') || link.startsWith('https://')) return true;
  if (link.startsWith('mailto:') || link.startsWith('tel:')) return true;
  if (/\.(png|jpg|jpeg|gif|svg|webp|ico|pdf|zip|gz|tar)$/i.test(link))
    return true;
  return false;
}

function extractLinks(line: string): string[] {
  const links: string[] = [];
  for (const re of [MD_LINK_RE, HREF_RE]) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(line)) !== null) {
      links.push(m[1]);
    }
  }
  return links;
}

async function main() {
  const files = await collectMdxFiles(CONTENT_DIR);

  if (files.length === 0) {
    console.log('No MDX files found to check.');
    return;
  }

  const routeMap = buildRouteMap(files);
  const broken: BrokenLink[] = [];

  for (const file of files) {
    const content = await Bun.file(file).text();
    const lines = content.split('\n');
    const rel = relative(ROOT, file).replaceAll('\\', '/');

    let inFrontmatter = false;
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];

      if (i === 0 && line.trim() === '---') {
        inFrontmatter = true;
        continue;
      }
      if (inFrontmatter) {
        if (line.trim() === '---') inFrontmatter = false;
        continue;
      }

      for (const raw of extractLinks(line)) {
        const link = raw.split('#')[0].split('?')[0];
        if (isSkippable(link)) continue;

        if (link.startsWith('/docs')) {
          if (GENERATED_PATH_RE.test(link)) continue;

          const normalized = link.endsWith('/') ? link.slice(0, -1) : link;
          if (!routeMap.has(normalized)) {
            broken.push({ file: rel, link: raw, line: i + 1 });
          }
        }
      }
    }
  }

  if (broken.length > 0) {
    console.error('\nBroken internal links:\n');
    for (const { file, link, line } of broken) {
      console.error(`  ${file}:${line}`);
      console.error(`    -> ${link}`);
    }
    console.error(`\n${broken.length} broken link(s) found.\n`);
    process.exit(1);
  }

  console.log(`Links valid: checked ${files.length} files.`);
}

main();
