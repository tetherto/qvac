// Plugins must register through the same @qvac/bare-sdk instance SDK calls
// resolve to — the registry is a module-level singleton.
import { loadModel, unloadModel, close } from "@qvac/bare-sdk";
import type { LoadModelOptions } from "@qvac/bare-sdk";
import { registerPlugin } from "@qvac/bare-sdk/plugins";
import { llmPlugin } from "@qvac/bare-sdk/llamacpp-completion/plugin";
import { embeddingsPlugin } from "@qvac/bare-sdk/llamacpp-embedding/plugin";
import { nmtPlugin } from "@qvac/bare-sdk/nmtcpp-translation/plugin";
import { whisperPlugin } from "@qvac/bare-sdk/whispercpp-transcription/plugin";

let pluginsRegistered = false;

export function ensurePlugins() {
  if (pluginsRegistered) return;
  registerPlugin(llmPlugin);
  registerPlugin(embeddingsPlugin);
  registerPlugin(nmtPlugin);
  registerPlugin(whisperPlugin);
  pluginsRegistered = true;
}

const loaded = new Map<string, string>();

// Real LoadModelOptions so the suite type-checks against the public signature.
export async function loadResource(key: string, options: LoadModelOptions) {
  const existing = loaded.get(key);
  if (existing) return existing;

  ensurePlugins();
  const modelId = await loadModel(options);

  loaded.set(key, modelId);
  return modelId;
}

// autoClose:false on purpose — autoClose runs terminal cleanupForTerminate
// (kills the shared worker), so we close once in suite-teardown instead.
export async function unloadAll() {
  for (const modelId of loaded.values()) {
    try {
      await unloadModel({ modelId, autoClose: false });
    } catch {
      // best-effort teardown
    }
  }
  loaded.clear();
}

// Bare keeps the worker alive across unloads; without this close the event
// loop never drains and the run hangs.
export async function closeWorker() {
  await close();
}
