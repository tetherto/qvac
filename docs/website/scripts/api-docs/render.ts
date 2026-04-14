#!/usr/bin/env bun
/**
 * Nunjucks-based renderer for API documentation.
 *
 * Reads a pre-generated api-data.json (conforming to ApiData), renders each
 * entry through Nunjucks templates, and writes .mdx files to the output
 * directory.
 */

import * as fs from "fs/promises";
import * as path from "path";
import * as nunjucks from "nunjucks";
import type { ApiData, ApiFunction } from "./types.js";

const TEMPLATES_DIR = path.resolve(__dirname, "templates");

function createEnvironment(): nunjucks.Environment {
  const env = new nunjucks.Environment(
    new nunjucks.FileSystemLoader(TEMPLATES_DIR),
    { autoescape: false, trimBlocks: true, lstripBlocks: true },
  );

  env.addFilter("escapeTable", (value: string) => {
    if (typeof value !== "string") return value;
    return value
      .replace(/\{/g, "\\{")
      .replace(/\}/g, "\\}")
      .replace(/\|/g, "\\|")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;");
  });

  env.addFilter("firstSentence", (text: string) => {
    if (typeof text !== "string") return text;
    const match = text.match(/^[^.!?]+[.!?]/);
    return match ? match[0] : text;
  });

  env.addFilter("slugify", (value: string) => {
    if (typeof value !== "string") return value;
    return value.toLowerCase().replace(/[^a-z0-9]+/g, "-");
  });

  env.addFilter("formatShortSignature", (fn: ApiFunction) => {
    const sig = fn.signature.replace(/^function\s+/, "");
    return sig.replace(/\|/g, "\\|");
  });

  env.addFilter("stripCodeFence", (value: string) => {
    if (typeof value !== "string") return value;
    return value.replace(/^```\w*\n?/, "").replace(/\n?```\s*$/, "");
  });

  return env;
}

export interface RenderOptions {
  dryRun?: boolean;
}

export async function renderApiDocs(
  dataPath: string,
  outputDir: string,
  options: RenderOptions = {},
): Promise<void> {
  const raw = await fs.readFile(dataPath, "utf-8");
  const data: ApiData = JSON.parse(raw);

  const env = createEnvironment();
  const versionLabel = data.version;

  if (!options.dryRun) {
    await fs.mkdir(outputDir, { recursive: true });
  }

  const objects = data.objects ?? [];

  console.log(`Rendering ${data.functions.length} function pages...`);

  for (const fn of data.functions) {
    const mdx = env.render("function.njk", { fn });
    const dest = path.join(outputDir, `${fn.name}.mdx`);

    if (options.dryRun) {
      console.log(`  [dry-run] ${dest}`);
    } else {
      await fs.writeFile(dest, mdx, "utf-8");
    }
  }

  if (objects.length > 0) {
    console.log(`Rendering ${objects.length} object pages...`);
  }

  for (const obj of objects) {
    const mdx = env.render("object.njk", { obj });
    const dest = path.join(outputDir, `${obj.name}.mdx`);

    if (options.dryRun) {
      console.log(`  [dry-run] ${dest}`);
    } else {
      await fs.writeFile(dest, mdx, "utf-8");
    }
  }

  const indexMdx = env.render("index.njk", {
    functions: data.functions,
    objects,
    versionLabel,
  });
  const indexDest = path.join(outputDir, "index.mdx");

  if (options.dryRun) {
    console.log(`  [dry-run] ${indexDest}`);
  } else {
    await fs.writeFile(indexDest, indexMdx, "utf-8");
  }

  const hasErrors =
    data.errors.client.length > 0 || data.errors.server.length > 0;

  if (hasErrors) {
    const errorsMdx = env.render("errors.njk", { errors: data.errors });
    const errorsDest = path.join(outputDir, "errors.mdx");

    if (options.dryRun) {
      console.log(`  [dry-run] ${errorsDest}`);
    } else {
      await fs.writeFile(errorsDest, errorsMdx, "utf-8");
    }
  }

  const total = data.functions.length + objects.length + 1 + (hasErrors ? 1 : 0);
  console.log(`Rendered ${total} MDX files to ${outputDir}`);
}
