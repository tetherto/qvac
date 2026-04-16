/**
 * Optional AI augmentation step for api-data.json.
 *
 * Reads the extracted data, identifies functions with content gaps
 * (thin descriptions, missing examples), calls an AI model to generate
 * first-draft content, and writes the augmented data back. All
 * AI-generated fields are tagged with `source: "ai"` so reviewers
 * can spot them on staging.
 *
 * Requires environment variables:
 *   AI_AUGMENT_BASE_URL  — OpenAI-compatible endpoint
 *   AI_AUGMENT_API_KEY   — API key
 *   AI_AUGMENT_MODEL     — Model identifier (e.g. "gpt-4o")
 */

import * as fs from "fs/promises";
import * as path from "path";
import { fileURLToPath } from "node:url";
import type { ApiData, ApiFunction, ApiObject } from "./types.js";
import { stripFence } from "./render.js";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const PROMPTS_DIR = path.join(SCRIPT_DIR, "prompts");

export interface AugmentOptions {
  dryRun?: boolean;
}

export interface AugmentResult {
  augmented: number;
  skipped: number;
}

// ---------------------------------------------------------------------------
// Gap detection
// ---------------------------------------------------------------------------

function isThinDescription(description: string): boolean {
  if (!description || description === "No description available") return true;
  const sentences = description.match(/[^.!?]+[.!?]/g);
  return !sentences || sentences.length < 2;
}

function isMissingExamples(fn: ApiFunction): boolean {
  return !fn.examples || fn.examples.length === 0;
}

// ---------------------------------------------------------------------------
// Prompt interpolation
// ---------------------------------------------------------------------------

async function loadPrompt(
  templateName: string,
  vars: Record<string, string>,
): Promise<string> {
  const templatePath = path.join(PROMPTS_DIR, templateName);
  let template = await fs.readFile(templatePath, "utf-8");
  for (const [key, value] of Object.entries(vars)) {
    template = template.replace(new RegExp(`\\{\\{${key}\\}\\}`, "g"), value);
  }
  return template;
}

function formatParameters(fn: ApiFunction): string {
  if (fn.parameters.length === 0) return "(none)";
  return fn.parameters
    .map((p) => `${p.name}: ${p.type}${p.required ? "" : " (optional)"}`)
    .join(", ");
}

// ---------------------------------------------------------------------------
// AI provider
// ---------------------------------------------------------------------------

async function callAI(prompt: string): Promise<string> {
  const { generateText } = await import("ai");
  const { createOpenAICompatible } = await import(
    "@ai-sdk/openai-compatible"
  );

  const baseURL = process.env.AI_AUGMENT_BASE_URL;
  const apiKey = process.env.AI_AUGMENT_API_KEY;
  const model = process.env.AI_AUGMENT_MODEL;

  if (!baseURL || !apiKey || !model) {
    throw new Error(
      "AI augmentation requires AI_AUGMENT_BASE_URL, AI_AUGMENT_API_KEY, and AI_AUGMENT_MODEL environment variables",
    );
  }

  const provider = createOpenAICompatible({
    name: "ai-augment",
    baseURL,
    apiKey,
  });

  const result = await generateText({
    model: provider.chatModel(model),
    prompt,
  });

  return result.text.trim();
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export function isAugmentConfigured(): boolean {
  return !!(
    process.env.AI_AUGMENT_BASE_URL &&
    process.env.AI_AUGMENT_API_KEY &&
    process.env.AI_AUGMENT_MODEL
  );
}

export async function augmentApiData(
  dataPath: string,
  options: AugmentOptions = {},
): Promise<AugmentResult> {
  const raw = await fs.readFile(dataPath, "utf-8");
  const apiData: ApiData = JSON.parse(raw);

  let augmented = 0;
  let skipped = 0;

  for (const fn of apiData.functions) {
    const gaps: string[] = [];

    if (isThinDescription(fn.description)) gaps.push("description");
    if (isMissingExamples(fn)) gaps.push("examples");

    if (gaps.length === 0) {
      skipped++;
      continue;
    }

    if (options.dryRun) {
      console.log(`  [dry-run] ${fn.name}: would augment ${gaps.join(", ")}`);
      augmented++;
      continue;
    }

    const promptVars = {
      name: fn.name,
      signature: fn.signature,
      parameters: formatParameters(fn),
      returnType: fn.returns?.type ?? "unknown",
      description: fn.description,
    };

    for (const gap of gaps) {
      try {
        if (gap === "description") {
          const prompt = await loadPrompt("function-description.txt", promptVars);
          const result = await callAI(prompt);
          fn.description = result;
          fn.descriptionSource = "ai";
          console.log(`  ✓ ${fn.name}: augmented description`);
        } else if (gap === "examples") {
          const prompt = await loadPrompt("usage-example.txt", promptVars);
          const result = await callAI(prompt);
          fn.examples = [`\`\`\`typescript\n${stripFence(result)}\n\`\`\``];
          fn.examplesSource = "ai";
          console.log(`  ✓ ${fn.name}: augmented example`);
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.log(`  ⚠️  ${fn.name}: failed to augment ${gap}: ${msg}`);
      }
    }

    augmented++;
  }

  if (apiData.objects) {
    for (const obj of apiData.objects) {
      const gaps: string[] = [];
      if (isThinDescription(obj.description)) gaps.push("description");
      if (!obj.examples || obj.examples.length === 0) gaps.push("examples");

      if (gaps.length === 0) {
        skipped++;
        continue;
      }

      if (options.dryRun) {
        console.log(`  [dry-run] ${obj.name}: would augment ${gaps.join(", ")}`);
        augmented++;
        continue;
      }

      const promptVars = {
        name: obj.name,
        signature: `interface ${obj.name}`,
        parameters: obj.fields
          .map((f) => `${f.name}: ${f.type}${f.required ? "" : " (optional)"}`)
          .join(", ") || "(none)",
        returnType: "N/A",
        description: obj.description,
      };

      for (const gap of gaps) {
        try {
          if (gap === "description") {
            const prompt = await loadPrompt("function-description.txt", promptVars);
            const result = await callAI(prompt);
            obj.description = result;
            obj.descriptionSource = "ai";
            console.log(`  ✓ ${obj.name}: augmented description`);
          } else if (gap === "examples") {
            const prompt = await loadPrompt("usage-example.txt", promptVars);
            const result = await callAI(prompt);
            obj.examples = [`\`\`\`typescript\n${stripFence(result)}\n\`\`\``];
            obj.examplesSource = "ai";
            console.log(`  ✓ ${obj.name}: augmented example`);
          }
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          console.log(`  ⚠️  ${obj.name}: failed to augment ${gap}: ${msg}`);
        }
      }
      augmented++;
    }
  }

  if (!options.dryRun) {
    await fs.writeFile(
      dataPath,
      JSON.stringify(apiData, null, 2) + "\n",
      "utf-8",
    );
  }

  return { augmented, skipped };
}

/**
 * Generate an AI-drafted release note summary for a changelog entry.
 * Uses the release-note-summary.txt prompt template.
 */
export async function generateReleaseSummary(
  changeType: string,
  description: string,
  functions: string,
): Promise<string | null> {
  if (!isAugmentConfigured()) return null;

  try {
    const prompt = await loadPrompt("release-note-summary.txt", {
      changeType,
      description,
      functions,
    });
    return await callAI(prompt);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.log(`  ⚠️  Failed to generate release summary: ${msg}`);
    return null;
  }
}
