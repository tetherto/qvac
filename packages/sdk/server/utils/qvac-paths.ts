import path from "bare-path";
import { getEnv } from "@/server/env";

export function getQvacPath(...subPaths: string[]): string {
  return path.join(getEnv().HOME_DIR, ".qvac", ...subPaths);
}
