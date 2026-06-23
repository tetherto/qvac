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

// Forwards the real loadModel options so the suite type-checks against the
// public signature like a consumer would. loadModel handles the download on
// cache miss — no separate downloadAsset needed.
export async function loadResource(key: string, options: LoadModelOptions) {
  const existing = loaded.get(key);
  if (existing) return existing;

  ensurePlugins();
  const modelId = await loadModel(options);

  loaded.set(key, modelId);
  return modelId;
}

// Never close here: autoClose runs cleanupForTerminate (clears plugins, kills
// the swarm) and the shared worker can't be revived for the next test.
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

// Close the worker once, after the suite — Bare keeps it alive across unloads,
// so the event loop won't drain (and the run hangs) without this.
export async function closeWorker() {
  await close();
}
