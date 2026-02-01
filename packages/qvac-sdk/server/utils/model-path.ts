import path from "bare-path";

export function parseModelPath(modelPath: string): {
  dirPath: string;
  basePath: string;
} {
  return {
    dirPath: path.dirname(modelPath),
    basePath: path.basename(modelPath),
  };
}
