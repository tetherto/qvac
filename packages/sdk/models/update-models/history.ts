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

export function separateUpdates(
  added: (ProcessedModel & { name: string })[],
  removed: CurrentModel[],
): {
  added: (ProcessedModel & { name: string })[];
  updated: (ProcessedModel & { name: string })[];
  removed: CurrentModel[];
} {
  const removedNames = new Set(removed.map((m) => m.name));
  const addedNames = new Set(added.map((m) => m.name));
  const updatedNames = new Set(
    [...addedNames].filter((name) => removedNames.has(name)),
  );

  return {
    added: added.filter((m) => !updatedNames.has(m.name)),
    updated: added.filter((m) => updatedNames.has(m.name)),
    removed: removed.filter((m) => !updatedNames.has(m.name)),
  };
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

  const {
    added: trulyAdded,
    updated,
    removed: trulyRemoved,
  } = separateUpdates(added, removed);

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
  content += `new_count=${currentModels.length + trulyAdded.length - trulyRemoved.length}\n`;
  content += `\n`;

  if (trulyAdded.length > 0) {
    content += `[added]\n`;
    trulyAdded.forEach((m) => {
      content += `${m.name}\n`;
    });
    content += `\n`;
  }

  if (updated.length > 0) {
    content += `[updated]\n`;
    updated.forEach((m) => {
      content += `${m.name}\n`;
    });
    content += `\n`;
  }

  if (trulyRemoved.length > 0) {
    content += `[removed]\n`;
    trulyRemoved.forEach((m) => {
      content += `${m.name}\n`;
    });
    content += `\n`;
  }

  fs.writeFileSync(filepath, content);
  return filepath;
}
