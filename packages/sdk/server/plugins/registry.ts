import {
  pluginDefinitionRuntimeSchema,
  type QvacPlugin,
  type PluginHandlerDefinition,
} from "@/schemas/plugin";
import {
  PluginAlreadyRegisteredError,
  PluginDefinitionInvalidError,
  PluginLoggingInvalidError,
} from "@/utils/errors-server";
import { createAddonLoggerCallback } from "@/logging/addon";

const plugins = new Map<string, QvacPlugin>();

function getModelTypeForError(plugin: unknown) {
  if (!plugin || typeof plugin !== "object") return "(unknown)";
  if (!("modelType" in plugin)) return "(unknown)";
  const modelType = (plugin as { modelType?: unknown }).modelType;
  return typeof modelType === "string" && modelType.length > 0
    ? modelType
    : "(unknown)";
}

function validatePluginDefinition(plugin: QvacPlugin): void {
  const result = pluginDefinitionRuntimeSchema.safeParse(plugin);
  if (result.success) return;

  const details = result.error.issues
    .map((i) => `${String(i.path.join("."))}: ${i.message}`)
    .join(", ");

  throw new PluginDefinitionInvalidError(getModelTypeForError(plugin), details);
}

export function registerPlugin(plugin: QvacPlugin): void {
  validatePluginDefinition(plugin);

  if (plugins.has(plugin.modelType)) {
    throw new PluginAlreadyRegisteredError(plugin.modelType);
  }

  // Validate logging module shape if provided
  if (plugin.logging?.module) {
    const loggingModule = plugin.logging.module as Record<string, unknown>;
    if (typeof loggingModule["setLogger"] !== "function") {
      throw new PluginLoggingInvalidError(
        plugin.modelType,
        "logging.module must have a setLogger(callback) function",
      );
    }
  }

  plugins.set(plugin.modelType, plugin);

  if (plugin.logging?.module && plugin.logging?.namespace) {
    const loggingModule = plugin.logging.module as {
      setLogger: (
        callback: (priority: number, message: string) => void,
      ) => void;
    };
    loggingModule.setLogger(
      createAddonLoggerCallback(plugin.logging.namespace),
    );
  }
}

export function getPlugin(modelType: string): QvacPlugin | undefined {
  return plugins.get(modelType);
}

export function getPluginHandler(
  modelType: string,
  handlerName: string,
): PluginHandlerDefinition | undefined {
  const plugin = plugins.get(modelType);
  if (!plugin) return undefined;
  return plugin.handlers[handlerName];
}

export function hasPlugin(modelType: string): boolean {
  return plugins.has(modelType);
}

export function unregisterPlugin(modelType: string): boolean {
  const plugin = plugins.get(modelType);
  if (!plugin) return false;

  if (plugin.logging?.module) {
    const loggingModule = plugin.logging.module as {
      releaseLogger?: () => void;
    };
    loggingModule.releaseLogger?.();
  }

  return plugins.delete(modelType);
}

export function getAllPlugins(): QvacPlugin[] {
  return Array.from(plugins.values());
}

export function clearPlugins(): void {
  for (const plugin of plugins.values()) {
    if (plugin.logging?.module) {
      const loggingModule = plugin.logging.module as {
        releaseLogger?: () => void;
      };
      loggingModule.releaseLogger?.();
    }
  }
  plugins.clear();
}
