import {
  defineConfig,
  defineDocs,
  frontmatterSchema,
  metaSchema,
} from 'fumadocs-mdx/config';
import { remarkMdxMermaid } from 'fumadocs-core/mdx-plugins';
import { z } from "zod";
import { resolve } from 'path';
import rehypeKatex from 'rehype-katex';
import remarkMath from 'remark-math';
import codeImport from 'remark-code-import';

const monorepoRoot = resolve(process.cwd(), '../..');

// You can customise Zod schemas for frontmatter and `meta.json` here
// see https://fumadocs.dev/docs/mdx/collections#define-docs
export const docs = defineDocs({
  docs: {
    schema: frontmatterSchema.extend({
      titleStyle: z.enum(["code", "text"]).optional(),
      version: z.string().optional(),
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
  mdxOptions: {
    remarkPlugins: [
      remarkMath,
      remarkMdxMermaid,
      [codeImport, { rootDir: monorepoRoot }],
    ],
    rehypePlugins: (v) => [rehypeKatex, ...v],
  },
});
