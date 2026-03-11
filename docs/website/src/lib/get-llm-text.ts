import { source } from '@/lib/source';
import type { InferPageType } from 'fumadocs-core/source';
import * as fs from 'fs/promises';
import * as path from 'path';

type Page = InferPageType<typeof source>;

const CONTENT_DIR = path.join(process.cwd(), 'content', 'docs');

export async function getLLMText(page: Page): Promise<string> {
  const mdxPath = path.join(CONTENT_DIR, page.file.path);
  let raw: string;
  try {
    raw = await fs.readFile(mdxPath, 'utf-8');
  } catch {
    return `# ${page.data.title} (${page.url})\n\n(content unavailable)`;
  }

  const body = stripFrontmatter(raw);
  const cleaned = stripMdxSyntax(body);

  return `# ${page.data.title} (${page.url})\n\n${cleaned}`;
}

function stripFrontmatter(raw: string): string {
  const match = raw.match(/^---\n[\s\S]*?\n---\n?([\s\S]*)$/);
  return match ? match[1].trim() : raw.trim();
}

function stripMdxSyntax(content: string): string {
  return content
    .replace(/^import\s+.*$/gm, '')
    .replace(/<[A-Z][a-zA-Z]*\s*\/>/g, '')
    .replace(/<[A-Z][a-zA-Z]*[^>]*>[\s\S]*?<\/[A-Z][a-zA-Z]*>/g, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
