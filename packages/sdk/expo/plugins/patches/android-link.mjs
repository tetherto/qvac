/**
 * Patched android/link.mjs for manifest-aware native addon linking.
 *
 * If qvac/addons.manifest.json exists, only links the allowlisted addons.
 * Otherwise, falls back to linking all installed addons.
 *
 * This file is copied over react-native-bare-kit/android/link.mjs
 * by withMobileBundle.ts during expo prebuild.
 */
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import link from "bare-link";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.join(__dirname, "..", "..", "..");
const addonsDir = path.join(__dirname, "src", "main", "addons");

if (fs.existsSync(addonsDir)) {
  console.log("[QVAC] Cleaning existing addons directory...");
  fs.rmSync(addonsDir, { recursive: true, force: true });
}

const manifestPath = path.join(projectRoot, "qvac", "addons.manifest.json");

let pkg = null;
if (fs.existsSync(manifestPath)) {
  try {
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    const addons = Array.isArray(manifest.addons) ? manifest.addons : [];

    if (addons.length > 0) {
      console.log(
        `[QVAC] Using addons manifest (${addons.length} addons): ${addons.join(", ")}`,
      );
      pkg = {
        name: "qvac-addon-linker",
        version: "0.0.0",
        dependencies: Object.fromEntries(addons.map((name) => [name, "*"])),
      };
    } else {
      console.log("[QVAC] Addons manifest is empty, linking all addons");
    }
  } catch (err) {
    console.warn(
      "[QVAC] Failed to parse addons manifest, linking all addons:",
      err.message,
    );
  }
} else {
  console.log("[QVAC] No addons manifest found, linking all addons");
}

for await (const resource of link(
  projectRoot,
  {
    hosts: ["android-arm64", "android-arm", "android-ia32", "android-x64"],
    out: addonsDir,
  },
  pkg,
)) {
  console.log("Wrote", resource);
}
