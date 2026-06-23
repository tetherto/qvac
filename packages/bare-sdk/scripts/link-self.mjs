// Symlink node_modules/@qvac/bare-sdk -> package root so the test suite imports
// by published name, exercising the real exports/imports maps (incl. the #rpc
// -> bare-client condition) like a consumer would. Idempotent.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const pkgRoot = path.resolve(here, "..");
const scopeDir = path.join(pkgRoot, "node_modules", "@qvac");
const linkPath = path.join(scopeDir, "bare-sdk");

fs.mkdirSync(scopeDir, { recursive: true });

let exists = false;
try {
  fs.lstatSync(linkPath);
  exists = true;
} catch {
  exists = false;
}

if (exists) {
  console.log(`[link-self] @qvac/bare-sdk already linked at ${linkPath}`);
} else {
  const type = process.platform === "win32" ? "junction" : "dir";
  fs.symlinkSync(pkgRoot, linkPath, type);
  console.log(`[link-self] linked @qvac/bare-sdk -> ${pkgRoot}`);
}
