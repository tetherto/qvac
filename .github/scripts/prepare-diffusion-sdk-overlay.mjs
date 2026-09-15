// Review-time SDK dependency for the same addon whose native CI uses the engine
// overlay. Production manifests retain their release ranges; only CI rewrites
// them to a tarball of this checkout until the addon release is published.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

export function linkDiffusionOverlay(root, tarball) {
  const addonDir = join(root, "packages/diffusion-cpp");
  if (
    !existsSync(
      join(addonDir, "vcpkg-overlay/ports/stable-diffusion-cpp/portfile.cmake"),
    )
  )
    return false;
  const { name, version } = JSON.parse(
    readFileSync(join(addonDir, "package.json"), "utf8"),
  );
  const spec = `file:${resolve(tarball).replaceAll("\\", "/")}`;
  const manifests = ["sdk", "inference"].map((pkg) => {
    const file = join(root, "packages", pkg, "package.json");
    return { file, pkg, manifest: JSON.parse(readFileSync(file, "utf8")) };
  });
  // Validate the committed release contract before applying an ephemeral link.
  // Check every range first, so mismatches fail without a partial rewrite.
  for (const { pkg, manifest } of manifests) {
    const fields =
      pkg === "sdk"
        ? ["dependencies"]
        : ["devDependencies", "peerDependencies"];
    for (const field of fields) {
      const range = manifest[field]?.[name];
      if (range !== `^${version}` && range !== spec) {
        throw new Error(
          `${pkg}.${field}.${name}: expected ^${version}, got ${range}`,
        );
      }
    }
  }
  if (!existsSync(tarball))
    throw new Error(`Missing PR addon tarball: ${tarball}`);
  for (const { file, pkg, manifest } of manifests) {
    const fields =
      pkg === "sdk"
        ? ["dependencies"]
        : ["devDependencies", "peerDependencies"];
    for (const field of fields) manifest[field][name] = spec;
    writeFileSync(file, JSON.stringify(manifest, null, 2) + "\n");
  }
  return true;
}

function main() {
  const root = resolve(process.argv[2]);
  const addonDir = join(root, "packages/diffusion-cpp");
  if (
    !existsSync(
      join(addonDir, "vcpkg-overlay/ports/stable-diffusion-cpp/portfile.cmake"),
    )
  )
    return;
  const { version } = JSON.parse(
    readFileSync(join(addonDir, "package.json"), "utf8"),
  );
  const dest = join(process.env.RUNNER_TEMP, "qvac-diffusion-sdk-overlay");
  const tarball = join(dest, `qvac-diffusion-cpp-${version}.tgz`);
  mkdirSync(dest, { recursive: true });
  if (!existsSync(tarball)) {
    execFileSync(
      "npm",
      ["pack", "--ignore-scripts", "--pack-destination", dest],
      {
        cwd: addonDir,
        stdio: "inherit",
      },
    );
  }
  linkDiffusionOverlay(root, tarball);
  console.log(`SDK checks use the PR addon: ${tarball}`);
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
)
  main();
