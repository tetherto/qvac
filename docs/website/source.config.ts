import {
  defineConfig,
  defineDocs,
  frontmatterSchema,
  metaSchema,
} from 'fumadocs-mdx/config';
import lastModified from 'fumadocs-mdx/plugins/last-modified';
import { remarkMdxMermaid } from 'fumadocs-core/mdx-plugins';
import { z } from "zod";
import { resolve } from 'path';
import rehypeKatex from 'rehype-katex';
import remarkMath from 'remark-math';
import codeImport from 'remark-code-import';
import { SCHEMA_TYPES } from './src/lib/docs-json-ld';

const monorepoRoot = resolve(process.cwd(), '../..');

// You can customise Zod schemas for frontmatter and `meta.json` here
// see https://fumadocs.dev/docs/mdx/collections#define-docs
export const docs = defineDocs({
  docs: {
    schema: frontmatterSchema.extend({
      titleStyle: z.enum(["code", "text"]).optional(),
      version: z.string().optional(),
      ogImage: z.string().optional(),
      schemaType: z.enum(SCHEMA_TYPES).optional(),
    }),
    postprocess: {
      includeProcessedMarkdown: true,
    },
  },
  meta: {
    schema: metaSchema,
  },
});

export default defineConfig({
  // Injects `page.data.lastModified: Date` from `git log -1` per MDX file at build time.
  // Consumed by `app/sitemap.ts` to emit `<lastmod>` entries.
  plugins: [lastModified()],
  mdxOptions: {
    remarkPlugins: [
      remarkMath,
      remarkMdxMermaid,
      [codeImport, { rootDir: monorepoRoot }],
    ],
    rehypePlugins: (v) => [rehypeKatex, ...v],
  },
});
