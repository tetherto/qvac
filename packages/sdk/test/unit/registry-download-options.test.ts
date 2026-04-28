// @ts-expect-error brittle has no type declarations
import test from "brittle";
import {
  DEFAULT_REGISTRY_STREAM_TIMEOUT_MS,
  buildRegistryClientOptions,
} from "@/server/rpc/handlers/load-model/registry-client-options";

const outputFile = "/tmp/model.bin";

test("buildRegistryClientOptions: falls back to default timeout and omits maxRetries", (t) => {
  const opts = buildRegistryClientOptions({
    sdkConfig: {},
    outputFile,
  });

  t.is(opts.timeout, DEFAULT_REGISTRY_STREAM_TIMEOUT_MS);
  t.is(opts.outputFile, outputFile);
  t.is(opts.maxRetries, undefined);
  t.is(opts.onProgress, undefined);
  t.is(opts.signal, undefined);
});

test("buildRegistryClientOptions: propagates registryStreamTimeoutMs from config", (t) => {
  const opts = buildRegistryClientOptions({
    sdkConfig: { registryStreamTimeoutMs: 120_000 },
    outputFile,
  });

  t.is(opts.timeout, 120_000);
});

test("buildRegistryClientOptions: propagates registryDownloadMaxRetries from config", (t) => {
  const opts = buildRegistryClientOptions({
    sdkConfig: { registryDownloadMaxRetries: 7 },
    outputFile,
  });

  t.is(opts.maxRetries, 7);
});

test("buildRegistryClientOptions: maxRetries=0 is propagated (retries disabled)", (t) => {
  const opts = buildRegistryClientOptions({
    sdkConfig: { registryDownloadMaxRetries: 0 },
    outputFile,
  });

  t.is(opts.maxRetries, 0);
});

test("buildRegistryClientOptions: forwards onProgress and signal when provided", (t) => {
  const controller = new AbortController();
  const onProgress = () => {};

  const opts = buildRegistryClientOptions({
    sdkConfig: {},
    outputFile,
    onProgress,
    signal: controller.signal,
  });

  t.is(opts.onProgress, onProgress);
  t.is(opts.signal, controller.signal);
});

test("buildRegistryClientOptions: config with both values passes both through", (t) => {
  const opts = buildRegistryClientOptions({
    sdkConfig: {
      registryStreamTimeoutMs: 90_000,
      registryDownloadMaxRetries: 5,
    },
    outputFile,
  });

  t.is(opts.timeout, 90_000);
  t.is(opts.maxRetries, 5);
});
