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
import remarkLineLinks from './src/lib/remark-line-links';
import remarkLineRoots from './src/lib/remark-line-roots';

const websiteRoot = process.cwd();
const monorepoRoot = resolve(websiteRoot, '../..');

// You can customise Zod schemas for frontmatter and `meta.json` here
// see https://fumadocs.dev/docs/mdx/collections#define-docs
export const docs = defineDocs({
  docs: {
    schema: frontmatterSchema.extend({
      // The sidebar entry's label, when it should read shorter than the page's
      // own title. A page's tree node otherwise takes `title` verbatim, which
      // is right for the page and too long beside its siblings — "Runtime
      // lifecycle" under a "Runtime" separator, say.
      sidebarTitle: z.string().optional(),
      titleStyle: z.enum(["code", "text"]).optional(),
      version: z.string().optional(),
      ogImage: z.string().optional(),
      schemaType: z.enum(SCHEMA_TYPES).optional(),
      tocMaxDepth: z.number().int().min(2).max(5).optional(),
      // The API symbols a hand-written page describes, checked against the
      // package's `api-bindings.lock.json` (`npm run docs:bindings`).
      binds: z.array(z.string()).optional(),
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
      // Before `codeImport`: a materialized line imports its examples from its
      // own snapshot, extracted from the commit it documents.
      [remarkLineRoots, { websiteRoot, monorepoRoot }],
      [codeImport, { rootDir: monorepoRoot }],
      remarkLineLinks,
    ],
    rehypePlugins: (v) => [rehypeKatex, ...v],
  },
});
