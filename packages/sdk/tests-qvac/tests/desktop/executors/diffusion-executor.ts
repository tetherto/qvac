import * as fs from "node:fs";
import * as path from "node:path";
import { DiffusionExecutor as SharedDiffusionExecutor } from "../../shared/executors/diffusion-executor.js";

export class DesktopDiffusionExecutor extends SharedDiffusionExecutor {
  protected override async resolveParams(
    p: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    if (typeof p.init_image !== "string") return p;

    const fileName = p.init_image.split("/").pop()!;
    const filePath = path.resolve(process.cwd(), "assets/images", fileName);
    return { ...p, init_image: new Uint8Array(fs.readFileSync(filePath)) };
  }
}
