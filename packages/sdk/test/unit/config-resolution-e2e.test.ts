// @ts-expect-error brittle has no type declarations
import test from "brittle";
import { ModelType, type RuntimeContext, type DevicePattern } from "@/schemas";
import {
  LLM_CONFIG_DEFAULTS,
  EMBED_CONFIG_DEFAULTS,
} from "@/schemas/llamacpp-config";
import {
  matchesPattern,
  findAllMatchingPatterns,
  getDefaultsFromPattern,
  resolveModelConfigWithContext,
  CANONICAL_TO_ALIAS,
  BUILTIN_DEVICE_PATTERNS,
  type ConfigResolutionLog,
} from "@/server/bare/registry/model-config-utils";

test("matchesPattern: matches Pixel device", (t) => {
  const ctx: RuntimeContext = {
    platform: "android",
    deviceModel: "Pixel 10 Pro",
    deviceBrand: "google",
  };

  t.ok(matchesPattern(ctx, { platform: "android" }));
  t.ok(matchesPattern(ctx, { deviceBrand: "google" }));
  t.ok(matchesPattern(ctx, { deviceModelPrefix: "Pixel" }));
  t.ok(
    matchesPattern(ctx, {
      platform: "android",
      deviceBrand: "google",
      deviceModelPrefix: "Pixel",
    }),
  );
});

test("matchesPattern: rejects non-matching", (t) => {
  const ctx: RuntimeContext = {
    platform: "ios",
    deviceModel: "iPhone 15",
    deviceBrand: "Apple",
  };

  t.absent(matchesPattern(ctx, { platform: "android" }));
  t.absent(matchesPattern(ctx, { deviceBrand: "google" }));
  t.absent(matchesPattern(ctx, { deviceModelPrefix: "Pixel" }));
});

test("findAllMatchingPatterns: returns all matches", (t) => {
  const ctx: RuntimeContext = { platform: "android", deviceBrand: "google" };
  const patterns: DevicePattern[] = [
    { name: "General", match: { platform: "android" }, defaults: {} },
    {
      name: "Specific",
      match: { platform: "android", deviceBrand: "google" },
      defaults: {},
    },
    { name: "iOS only", match: { platform: "ios" }, defaults: {} },
  ];

  const result = findAllMatchingPatterns(ctx, patterns);
  t.is(result.length, 2);
  t.is(result[0].name, "General");
  t.is(result[1].name, "Specific");
});

test("getDefaultsFromPattern: canonical key", (t) => {
  const pattern: DevicePattern = {
    name: "Test",
    match: {},
    defaults: {
      [ModelType.llamacppCompletion]: { device: "cpu" },
    },
  };

  const result = getDefaultsFromPattern(ModelType.llamacppCompletion, pattern);
  t.alike(result, { device: "cpu" });
});

test("getDefaultsFromPattern: alias key fallback", (t) => {
  const pattern: DevicePattern = {
    name: "Test",
    match: {},
    defaults: {
      llm: { device: "cpu" },
    },
  };

  const result = getDefaultsFromPattern(ModelType.llamacppCompletion, pattern);
  t.alike(result, { device: "cpu" });
});

test("CANONICAL_TO_ALIAS: correct mappings", (t) => {
  t.is(CANONICAL_TO_ALIAS[ModelType.llamacppCompletion], "llm");
  t.is(CANONICAL_TO_ALIAS[ModelType.llamacppEmbedding], "embeddings");
  t.is(CANONICAL_TO_ALIAS[ModelType.whispercppTranscription], "whisper");
});

test("no patterns match = schema defaults only", (t) => {
  const ctx: RuntimeContext = { runtime: "node", platform: "darwin" };
  const result = resolveModelConfigWithContext<Record<string, unknown>>(
    ModelType.llamacppCompletion,
    {},
    ctx,
    [],
    [],
  );

  t.is(result.device, LLM_CONFIG_DEFAULTS.device);
  t.is(result.ctx_size, LLM_CONFIG_DEFAULTS.ctx_size);
});

test("multiple patterns merge (general → specific)", (t) => {
  const ctx: RuntimeContext = { platform: "android", deviceBrand: "google" };
  const builtinPatterns: DevicePattern[] = [
    {
      name: "General Android",
      match: { platform: "android" },
      defaults: {
        [ModelType.llamacppCompletion]: { device: "vulkan", gpu_layers: 10 },
      },
    },
    {
      name: "Google devices",
      match: { platform: "android", deviceBrand: "google" },
      defaults: { [ModelType.llamacppCompletion]: { device: "cpu" } },
    },
  ];

  const result = resolveModelConfigWithContext<Record<string, unknown>>(
    ModelType.llamacppCompletion,
    {},
    ctx,
    [],
    builtinPatterns,
  );

  t.is(result.device, "cpu");
  t.is(result.gpu_layers, 10);
});

test("user input overrides all patterns", (t) => {
  const ctx: RuntimeContext = { platform: "android" };
  const builtinPatterns: DevicePattern[] = [
    {
      name: "Android",
      match: { platform: "android" },
      defaults: {
        [ModelType.llamacppCompletion]: { device: "cpu", gpu_layers: 0 },
      },
    },
  ];

  const result = resolveModelConfigWithContext<Record<string, unknown>>(
    ModelType.llamacppCompletion,
    { device: "gpu", ctx_size: 2048 },
    ctx,
    [],
    builtinPatterns,
  );

  t.is(result.device, "gpu");
  t.is(result.ctx_size, 2048);
  t.is(result.gpu_layers, 0);
});

test("user patterns override builtin patterns", (t) => {
  const ctx: RuntimeContext = { platform: "android" };
  const builtinPatterns: DevicePattern[] = [
    {
      name: "Builtin",
      match: { platform: "android" },
      defaults: {
        [ModelType.llamacppCompletion]: { device: "cpu", gpu_layers: 0 },
      },
    },
  ];
  const userPatterns: DevicePattern[] = [
    {
      name: "User override",
      match: { platform: "android" },
      defaults: { [ModelType.llamacppCompletion]: { device: "vulkan" } },
    },
  ];

  const result = resolveModelConfigWithContext<Record<string, unknown>>(
    ModelType.llamacppCompletion,
    {},
    ctx,
    userPatterns,
    builtinPatterns,
  );

  t.is(result.device, "vulkan");
  t.is(result.gpu_layers, 0);
});

test("onLog callback reports applied patterns", (t) => {
  const ctx: RuntimeContext = { platform: "android", deviceBrand: "google" };
  const patterns: DevicePattern[] = [
    {
      name: "Pattern A",
      match: { platform: "android" },
      defaults: { [ModelType.llamacppCompletion]: { device: "cpu" } },
    },
    {
      name: "Pattern B",
      match: { platform: "android", deviceBrand: "google" },
      defaults: { [ModelType.llamacppCompletion]: { gpu_layers: 5 } },
    },
  ];

  let log: ConfigResolutionLog | undefined;
  resolveModelConfigWithContext(
    ModelType.llamacppCompletion,
    {},
    ctx,
    [],
    patterns,
    (l) => {
      log = l;
    },
  );

  t.ok(log);
  t.alike(log?.appliedPatterns, ["Pattern A", "Pattern B"]);
  t.is(log?.mergedDefaults.device, "cpu");
  t.is(log?.mergedDefaults.gpu_layers, 5);
});

// ============================================
// Tests using actual BUILTIN_DEVICE_PATTERNS
// ============================================

test("BUILTIN: Pixel device gets cpu + flashAttention off", (t) => {
  const ctx: RuntimeContext = {
    runtime: "react-native",
    platform: "android",
    deviceModel: "Pixel 10 Pro",
    deviceBrand: "google",
  };

  let log: ConfigResolutionLog | undefined;

  const llmResult = resolveModelConfigWithContext<Record<string, unknown>>(
    ModelType.llamacppCompletion,
    {},
    ctx,
    [],
    BUILTIN_DEVICE_PATTERNS,
    (l) => {
      log = l;
    },
  );

  t.alike(log?.appliedPatterns, ["Pixel devices (SDK default)"]);
  t.is(llmResult.device, "cpu");
  t.is(llmResult.ctx_size, LLM_CONFIG_DEFAULTS.ctx_size);

  const embedResult = resolveModelConfigWithContext<Record<string, unknown>>(
    ModelType.llamacppEmbedding,
    {},
    ctx,
    [],
    BUILTIN_DEVICE_PATTERNS,
    (l) => {
      log = l;
    },
  );

  t.alike(log?.appliedPatterns, [
    "Android devices (SDK default)",
    "Pixel devices (SDK default)",
  ]);
  t.is(embedResult.device, "cpu");
  t.is(embedResult.flashAttention, "off");
});

test("BUILTIN: Non-Pixel Android gets flashAttention off only", (t) => {
  const ctx: RuntimeContext = {
    runtime: "react-native",
    platform: "android",
    deviceModel: "Galaxy S24",
    deviceBrand: "samsung",
  };

  let log: ConfigResolutionLog | undefined;

  const llmResult = resolveModelConfigWithContext<Record<string, unknown>>(
    ModelType.llamacppCompletion,
    {},
    ctx,
    [],
    BUILTIN_DEVICE_PATTERNS,
    (l) => {
      log = l;
    },
  );

  t.alike(log?.appliedPatterns, []);
  t.is(llmResult.device, LLM_CONFIG_DEFAULTS.device);

  const embedResult = resolveModelConfigWithContext<Record<string, unknown>>(
    ModelType.llamacppEmbedding,
    {},
    ctx,
    [],
    BUILTIN_DEVICE_PATTERNS,
    (l) => {
      log = l;
    },
  );

  t.alike(log?.appliedPatterns, ["Android devices (SDK default)"]);
  t.is(embedResult.device, EMBED_CONFIG_DEFAULTS.device);
  t.is(embedResult.flashAttention, "off");
});

test("BUILTIN: iOS gets no device defaults", (t) => {
  const ctx: RuntimeContext = {
    runtime: "react-native",
    platform: "ios",
    deviceModel: "iPhone 15 Pro",
    deviceBrand: "Apple",
  };

  let log: ConfigResolutionLog | undefined;

  const embedResult = resolveModelConfigWithContext<Record<string, unknown>>(
    ModelType.llamacppEmbedding,
    {},
    ctx,
    [],
    BUILTIN_DEVICE_PATTERNS,
    (l) => {
      log = l;
    },
  );

  t.alike(log?.appliedPatterns, []);
  t.is(embedResult.device, EMBED_CONFIG_DEFAULTS.device);
  t.is(embedResult.flashAttention, undefined);
});

test("BUILTIN: User can override device defaults", (t) => {
  const ctx: RuntimeContext = {
    runtime: "react-native",
    platform: "android",
    deviceModel: "Pixel 10 Pro",
    deviceBrand: "google",
  };

  const result = resolveModelConfigWithContext<Record<string, unknown>>(
    ModelType.llamacppCompletion,
    { device: "vulkan" },
    ctx,
    [],
    BUILTIN_DEVICE_PATTERNS,
  );

  t.is(result.device, "vulkan");
});
