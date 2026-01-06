import type EventEmitter from "events";
import {
  ModelAlreadyRegisteredError,
  ModelNotFoundError,
  ModelIsDelegatedError,
} from "@/utils/errors-server";
import type FilesystemDL from "@qvac/dl-filesystem";
import type { ModelType } from "@/schemas";
import { getServerLogger } from "@/logging";

const logger = getServerLogger();

interface AddonInterface {
  cancel(jobId?: string): Promise<void>;
}

// TODO: this common interface is a hack to work around the lack of proper typedefs from addons
export interface AnyModel {
  load(...args: unknown[]): Promise<void>;
  run(input: unknown): Promise<
    EventEmitter & {
      onUpdate(callback: (data: string) => void): {
        await: () => Promise<void>;
      };
      onUpdate(callback: (data: { outputArray: Int16Array }) => void): {
        await: () => Promise<void>;
      };
      onError(callback: (error: Error) => void): void;
      onUpdate(callback: (data: Array<{ text: string }>) => void): {
        await: () => Promise<void>;
      };
      cancel(): Promise<void>;
      iterate(): AsyncIterableIterator<string | Array<{ text: string }>>;
      await(): Promise<void>;
    }
  >;
  reload?(config: unknown): Promise<void>;
  unload?(): Promise<void>;
  addon?: AddonInterface; // Just included for the cancel method, should be removed when cancel is included directly on the model
}

interface DelegateOptions {
  topic: string;
  providerPublicKey: string;
  timeout?: number | undefined;
}

interface LocalOptions {
  model: AnyModel;
  path: string;
  loadedAt: Date;
  config: unknown;
  modelType: ModelType;
  name?: string | undefined;
  loader: FilesystemDL;
}

export interface ModelEntry {
  id: string;
  isDelegated: boolean;
  local?: LocalOptions;
  delegated?: DelegateOptions;
}

// Global registry state - using stateless functions to manage it
const modelRegistry = new Map<string, ModelEntry>();

export function registerModel(
  id: string,
  options:
    | {
        model: AnyModel;
        path: string;
        config: unknown;
        modelType: ModelType;
        loader: FilesystemDL;
        name?: string | undefined;
      }
    | { topic: string; providerPublicKey: string; timeout?: number },
): void {
  if (modelRegistry.has(id)) {
    throw new ModelAlreadyRegisteredError(id);
  }

  const isDelegated = "topic" in options && "providerPublicKey" in options;

  if (isDelegated) {
    const { topic, providerPublicKey, timeout } = options;
    modelRegistry.set(id, {
      id,
      isDelegated: true,
      delegated: {
        topic,
        providerPublicKey,
        timeout,
      },
    });

    logger.info(
      `Delegated model registered: ${id} -> topic: ${topic}, provider: ${providerPublicKey}, timeout: ${timeout}ms`,
    );
  } else {
    modelRegistry.set(id, {
      id,
      isDelegated: false,
      local: {
        model: options.model,
        path: options.path,
        loadedAt: new Date(),
        config: options.config,
        modelType: options.modelType,
        loader: options.loader,
        name: options.name,
      },
    });

    const nameStr = options.name ? ` (${options.name})` : "";
    logger.info(`Local model registered: ${id}${nameStr} -> ${options.path}`);
  }
}

export function getModelEntry(id: string): ModelEntry | null {
  return modelRegistry.get(id) || null;
}

export function getModel(id: string): AnyModel {
  const entry = modelRegistry.get(id);
  if (!entry) {
    throw new ModelNotFoundError(id);
  }

  if (!entry.local) {
    throw new ModelIsDelegatedError(id);
  }

  return entry.local.model;
}

export function isModelLoaded(id: string): boolean {
  return modelRegistry.has(id);
}

export function unregisterModel(id: string): ModelEntry | null {
  const entry = modelRegistry.get(id);
  if (entry) {
    modelRegistry.delete(id);
    logger.debug(`Model unregistered: ${id}`);
    return entry;
  }
  return null;
}

export function getAllModelIds(): string[] {
  return Array.from(modelRegistry.keys());
}

export function getModelInfo(id: string): {
  id: string;
  path: string;
  loadedAt: Date;
  config: unknown;
  name?: string;
} | null {
  const entry = modelRegistry.get(id);
  if (!entry || !entry.local) {
    return null;
  }

  const result: {
    id: string;
    path: string;
    loadedAt: Date;
    config: unknown;
    name?: string;
  } = {
    id: entry.id,
    path: entry.local.path,
    loadedAt: entry.local.loadedAt,
    config: entry.local.config,
  };

  if (entry.local.name) {
    result.name = entry.local.name;
  }

  return result;
}

export function getModelConfig(id: string): unknown {
  const entry = modelRegistry.get(id);
  if (!entry || !entry.local) {
    throw new ModelNotFoundError(id);
  }
  return entry.local.config;
}

export function updateModelConfig(id: string, config: unknown): void {
  const entry = modelRegistry.get(id);
  if (!entry) {
    throw new ModelNotFoundError(id);
  }
  if (!entry.local) {
    throw new ModelIsDelegatedError(id);
  }
  entry.local.config = config;
}

export function clearRegistry(): void {
  modelRegistry.clear();
  logger.info("Model registry cleared");
}

export function getRegistryStats(): {
  totalModels: number;
  modelIds: string[];
} {
  return {
    totalModels: modelRegistry.size,
    modelIds: Array.from(modelRegistry.keys()),
  };
}

export async function unloadAllModels(): Promise<void> {
  const modelIds = getAllModelIds();

  for (const modelId of modelIds) {
    const entry = modelRegistry.get(modelId);
    if (entry?.local?.model && entry.local.model.unload) {
      await entry.local.model.unload();
      logger.debug(`Model unloaded: ${modelId}`);
    }
    modelRegistry.delete(modelId);
  }

  logger.info(`Unloaded ${modelIds.length} models`);
}
