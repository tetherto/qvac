import { readdir } from 'node:fs/promises';
import { join, relative } from 'node:path';
import matter from 'gray-matter';
import { z } from 'zod';

const ROOT = join(import.meta.dir, '..');
const CONTENT_DIR = join(ROOT, 'content', 'docs');
const SKIP_DIRS = new Set(['.latest-backup', 'node_modules', '.source', '.next']);

const frontmatterSchema = z.object({
  title: z
    .string({ required_error: 'Missing required field: title' })
    .min(1, 'title must not be empty'),
  description: z
    .string({ required_error: 'Missing required field: description' })
    .min(1, 'description must not be empty'),
  titleStyle: z.enum(['code', 'text']).optional(),
  version: z.string().optional(),
});

interface ValidationError {
  file: string;
  errors: string[];
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

async function main() {
  const files = await collectMdxFiles(CONTENT_DIR);

  if (files.length === 0) {
    console.log('No MDX files found to validate.');
    return;
  }

  const errors: ValidationError[] = [];

  for (const file of files) {
    const content = await Bun.file(file).text();
    const rel = relative(ROOT, file).replaceAll('\\', '/');

    try {
      const { data } = matter(content);
      const result = frontmatterSchema.safeParse(data);

      if (!result.success) {
        errors.push({
          file: rel,
          errors: result.error.issues.map(
            (i) =>
              `${i.path.length ? i.path.join('.') + ': ' : ''}${i.message}`,
          ),
        });
      }
    } catch (err) {
      errors.push({
        file: rel,
        errors: [
          `Failed to parse frontmatter: ${err instanceof Error ? err.message : String(err)}`,
        ],
      });
    }
  }

  if (errors.length > 0) {
    console.error('\nFrontmatter validation failed:\n');
    for (const { file, errors: errs } of errors) {
      console.error(`  ${file}`);
      for (const e of errs) {
        console.error(`    - ${e}`);
      }
    }
    console.error(
      `\n${errors.length} file(s) with errors out of ${files.length} checked.\n`,
    );
    process.exit(1);
  }

  console.log(`Frontmatter valid: ${files.length} MDX files checked.`);
}

main();
