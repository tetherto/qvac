import {
  pluginDefinitionRuntimeSchema,
  type QvacPlugin,
  type PluginHandlerDefinition,
} from "@/schemas/plugin";
import { isModelTypeAlias } from "@/schemas";
import {
  PluginAlreadyRegisteredError,
  PluginDefinitionInvalidError,
  PluginLoggingInvalidError,
  PluginModelTypeReservedError,
} from "@/utils/errors-server";
import { createAddonLoggerCallback } from "@/logging/addon";

const plugins = new Map<string, QvacPlugin>();

// A single addon's logging module (e.g., `@qvac/diffusion-cpp/addonLogging`)
// has one global setLogger slot and is shared across every plugin that
// targets that addon (e.g., diffusion + upscaler both use diffusion-cpp).
// We dedup setLogger/releaseLogger by module identity and fan out native
// log lines to every namespace currently bound to the module.
type AddonLoggerCallback = (priority: number, message: string) => void;

type AddonLoggerModule = {
  setLogger: (callback: AddonLoggerCallback) => void;
  releaseLogger?: () => void;
};

type SharedAddonLoggerEntry = {
  namespaces: Set<string>;
  callbacks: Map<string, AddonLoggerCallback>;
};

const sharedAddonLoggers = new WeakMap<object, SharedAddonLoggerEntry>();

function attachPluginLogger(module: AddonLoggerModule, namespace: string) {
  let entry = sharedAddonLoggers.get(module);
  if (!entry) {
    const namespaces = new Set<string>();
    const callbacks = new Map<string, AddonLoggerCallback>();
    entry = { namespaces, callbacks };
    sharedAddonLoggers.set(module, entry);
    module.setLogger((priority, message) => {
      for (const ns of namespaces) {
        let cb = callbacks.get(ns);
        if (!cb) {
          cb = createAddonLoggerCallback(ns);
          callbacks.set(ns, cb);
        }
        cb(priority, message);
      }
    });
  }
  entry.namespaces.add(namespace);
}

function detachPluginLogger(module: AddonLoggerModule, namespace: string) {
  const entry = sharedAddonLoggers.get(module);
  if (!entry) return;
  entry.namespaces.delete(namespace);
  entry.callbacks.delete(namespace);
  if (entry.namespaces.size === 0) {
    module.releaseLogger?.();
    sharedAddonLoggers.delete(module);
  }
}

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

  if (isModelTypeAlias(plugin.modelType)) {
    throw new PluginModelTypeReservedError(plugin.modelType);
  }

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
    attachPluginLogger(
      plugin.logging.module as AddonLoggerModule,
      plugin.logging.namespace,
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

  if (plugin.logging?.module && plugin.logging?.namespace) {
    detachPluginLogger(
      plugin.logging.module as AddonLoggerModule,
      plugin.logging.namespace,
    );
  }

  return plugins.delete(modelType);
}

export function getAllPlugins(): QvacPlugin[] {
  return Array.from(plugins.values());
}

export function clearPlugins(): void {
  for (const plugin of plugins.values()) {
    if (plugin.logging?.module && plugin.logging?.namespace) {
      detachPluginLogger(
        plugin.logging.module as AddonLoggerModule,
        plugin.logging.namespace,
      );
    }
  }
  plugins.clear();
}
