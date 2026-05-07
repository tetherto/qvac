import * as fs from "node:fs";
import * as path from "node:path";
import { DiffusionExecutor as SharedDiffusionExecutor } from "../../shared/executors/diffusion-executor.js";

function readImageBytes(name: string): Uint8Array {
  const fileName = name.split("/").pop()!;
  const filePath = path.resolve(process.cwd(), "assets/images", fileName);
  return new Uint8Array(fs.readFileSync(filePath));
}

export class DesktopDiffusionExecutor extends SharedDiffusionExecutor {
  protected override async resolveParams(
    p: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const out: Record<string, unknown> = { ...p };

    if (p.init_image !== undefined) {
      if (typeof p.init_image !== "string") {
        throw new Error(
          `init_image in test params must be a string filename, got: ${typeof p.init_image}`,
        );
      }
      out.init_image = readImageBytes(p.init_image);
    }

    if (p.init_images !== undefined) {
      if (
        !Array.isArray(p.init_images) ||
        !p.init_images.every((v) => typeof v === "string")
      ) {
        throw new Error(
          "init_images in test params must be a string[] of image filenames",
        );
      }
      out.init_images = (p.init_images as string[]).map(readImageBytes);
    }

    return out;
  }
}
