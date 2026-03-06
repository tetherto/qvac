import fs from "fs";
import { generateExportName } from "./naming";
import type { CurrentModel, ProcessedModel } from "./types";
import { getCommitHash } from "./utils";

export function loadCurrentModels(outputFile: string): CurrentModel[] {
  try {
    if (!fs.existsSync(outputFile)) {
      return [];
    }

    const content = fs.readFileSync(outputFile, "utf-8");
    const modelsMatch = content.match(
      /export const models = \[([\s\S]*?)\] as const/,
    );

    if (!modelsMatch?.[1]) {
      return [];
    }

    const modelsArrayContent = modelsMatch[1];
    const currentModels: CurrentModel[] = [];

    const modelRegex =
      /\{[^}]+name:\s*"([^"]+)"[^}]+(?:registryPath|hyperbeeKey):\s*"([^"]+)"[^}]+\}/g;
    let match;

    while ((match = modelRegex.exec(modelsArrayContent)) !== null) {
      if (match[1] && match[2]) {
        currentModels.push({
          name: match[1],
          registryPath: match[2],
        });
      }
    }

    return currentModels;
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    console.warn("⚠️  Could not load current models:", message);
    return [];
  }
}

export function compareModels(
  remoteModels: ProcessedModel[],
  currentModels: CurrentModel[],
): { added: ProcessedModel[]; removed: CurrentModel[] } {
  const currentPaths = new Set(currentModels.map((m) => m.registryPath));
  const remotePaths = new Set(remoteModels.map((m) => m.registryPath));

  const added = remoteModels.filter((m) => !currentPaths.has(m.registryPath));
  const removed = currentModels.filter((m) => !remotePaths.has(m.registryPath));

  return { added, removed };
}

export function assignNames(
  models: ProcessedModel[],
): (ProcessedModel & { name: string })[] {
  const usedNames = new Set<string>();
  return models.map((m) => ({
    ...m,
    name: generateExportName({
      path: m.registryPath,
      engine: m.engine,
      name: m.modelName,
      quantization: m.quantization,
      params: m.params,
      tags: m.tags,
      usedNames,
    }),
  }));
}

export function createHistoryFile(
  added: (ProcessedModel & { name: string })[],
  removed: CurrentModel[],
  currentModels: CurrentModel[],
  historyDir: string,
): string | null {
  if (added.length === 0 && removed.length === 0) {
    return null;
  }

  if (!fs.existsSync(historyDir)) {
    fs.mkdirSync(historyDir, { recursive: true });
  }

  const shortHash = getCommitHash(true);
  const fullHash = getCommitHash(false);
  const timestamp = new Date().toISOString();
  const filename = `${shortHash}.txt`;
  const filepath = `${historyDir}/${filename}`;

  let content = `commit=${fullHash}\n`;
  content += `timestamp=${timestamp}\n`;
  content += `previous_count=${currentModels.length}\n`;
  content += `new_count=${currentModels.length + added.length - removed.length}\n`;
  content += `\n`;

  if (added.length > 0) {
    content += `[added]\n`;
    added.forEach((m) => {
      content += `${m.name}\n`;
    });
    content += `\n`;
  }

  if (removed.length > 0) {
    content += `[removed]\n`;
    removed.forEach((m) => {
      content += `${m.name}\n`;
    });
  }

  fs.writeFileSync(filepath, content);
  return filepath;
}
