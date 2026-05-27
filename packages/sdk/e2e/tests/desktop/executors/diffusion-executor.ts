import * as fs from "node:fs";
import * as path from "node:path";
import {
  DiffusionExecutor as SharedDiffusionExecutor,
  type DiffusionParams,
} from "../../shared/executors/diffusion-executor.js";

function readImageBytes(name: string): Uint8Array {
  const fileName = name.split("/").pop()!;
  const filePath = path.resolve(process.cwd(), "assets/images", fileName);
  return new Uint8Array(fs.readFileSync(filePath));
}

export class DesktopDiffusionExecutor extends SharedDiffusionExecutor {
  // Resolve string filenames declared in test params to bytes via Node fs.
  protected override async resolveParams(
    p: DiffusionParams,
  ): Promise<DiffusionParams> {
    const out: DiffusionParams = { ...p };

    if (typeof p.init_image === "string") {
      out.init_image = readImageBytes(p.init_image);
    }

    if (typeof p.image === "string") {
      out.image = readImageBytes(p.image);
    }

    if (Array.isArray(p.init_images)) {
      if (!p.init_images.every((v): v is string => typeof v === "string")) {
        throw new Error(
          "init_images in test params must be a string[] of image filenames",
        );
      }
      out.init_images = p.init_images.map(readImageBytes);
    }

    return out;
  }
}
