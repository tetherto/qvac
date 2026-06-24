import type { BCIWhispercppArgs } from "@qvac/bci-whispercpp";

export function buildBciWhispercppArgs(
  modelPath: string,
  embedderPath: string,
  logger: NonNullable<BCIWhispercppArgs["logger"]>,
) {
  const args: BCIWhispercppArgs = {
    files: {
      model: modelPath,
      ...(embedderPath ? { embedder: embedderPath } : {}),
    },
    logger,
    opts: {
      stats: true,
    },
  };

  return args;
}
