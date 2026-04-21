/**
 * Sample passthrough helpers.
 *
 * The API docs pipeline prefers the hand-authored MDX samples living in
 * `content/docs/(latest)/sdk/api/` as the source of truth for prose. These
 * helpers let the renderer check whether a sample exists for a given output
 * file name and copy it verbatim, falling back to TypeScript-based generation
 * only when no sample is available (typically for newly added SDK APIs).
 */

import * as fs from "fs/promises";
import * as path from "path";

/**
 * Read the raw MDX content of `{samplesDir}/{name}.mdx`.
 *
 * @returns The file contents as a string, or `null` when the sample does not
 *   exist. Any other read error is rethrown (unreadable file != missing file).
 */
export async function readSample(
  samplesDir: string,
  name: string,
): Promise<string | null> {
  const samplePath = path.join(samplesDir, `${name}.mdx`);
  try {
    return await fs.readFile(samplePath, "utf-8");
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return null;
    throw err;
  }
}

/**
 * If a sample exists for `name` under `samplesDir`, copy it verbatim to
 * `{outputDir}/{outputName}.mdx` and return `true`. Otherwise return `false`
 * so the caller can fall back to generation.
 *
 * `outputName` defaults to `name` but can differ (e.g., sample is
 * `shared-types.mdx` while the pipeline's internal name is `types`).
 */
export async function copySampleIfExists(
  samplesDir: string,
  outputDir: string,
  name: string,
  outputName: string = name,
): Promise<boolean> {
  const content = await readSample(samplesDir, name);
  if (content === null) return false;
  await fs.writeFile(
    path.join(outputDir, `${outputName}.mdx`),
    content,
    "utf-8",
  );
  return true;
}

/**
 * Summary of a passthrough pass: how many files came from samples vs how many
 * required fresh rendering. Returned by `renderApiDocs` so callers can log
 * provenance for reviewers.
 */
export interface PassthroughSummary {
  copied: string[];
  generated: string[];
}
