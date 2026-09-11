/**
 * Allow-list of the public object singletons rendered in the `## Objects`
 * section of the API summary.
 *
 * `packages/sdk/src/index.ts` re-exports some of its public surface from
 * sibling workspace packages. TypeDoc converts such a re-export as a
 * `Reference` reflection whose target lives outside the SDK program, so the
 * singleton never appears as a `Variable` in the SDK project and cannot be
 * discovered by walking it. Each entry therefore names the package that owns
 * the declaration, and the extractor converts that entry point in a second
 * TypeDoc pass when the SDK project alone does not yield the singleton.
 *
 * Membership is an editorial decision: these objects show up on the
 * single-page summary, so the bar is intentional. Extraction fails loudly when
 * an entry cannot be resolved, so a future refactor that moves a declaration
 * cannot silently drop a whole object from the page.
 */
import { existsSync } from "node:fs";
import * as path from "path";
import { Application, ReflectionKind } from "typedoc";
import type { DeclarationReflection, ProjectReflection } from "typedoc";

export interface CuratedSingleton {
  /** Exported identifier, as re-exported from `packages/sdk/src/index.ts`. */
  name: string;
  /** Package directory owning the declaration, relative to the SDK package. */
  packageDir: string;
  /** TypeDoc entry point that declares the singleton, relative to `packageDir`. */
  entryPoint: string;
}

export const CURATED_SINGLETONS: CuratedSingleton[] = [
  {
    // Re-exported by the SDK from `@qvac/inference/surface`.
    name: "profiler",
    packageDir: "../inference",
    entryPoint: "src/profiling/index.ts",
  },
];

export const CURATED_SINGLETON_NAMES: ReadonlySet<string> = new Set(
  CURATED_SINGLETONS.map((s) => s.name),
);

/**
 * Absolute path of a curated singleton's TypeDoc entry point.
 */
export function resolveCuratedEntryPoint(
  sdkPath: string,
  singleton: CuratedSingleton,
): string {
  return path
    .resolve(sdkPath, singleton.packageDir, singleton.entryPoint)
    .replace(/\\/g, "/");
}

/**
 * Convert the packages owning the curated singletons that the SDK project does
 * not expose as `Variable` reflections.
 *
 * The owning package cannot be added as a second entry point on the SDK
 * conversion — it is not part of the SDK's tsconfig program — so it gets its
 * own conversion, against its own tsconfig.
 *
 * Returns the resolved `Variable` reflections plus the projects they came from,
 * so a caller can pull named types (`ProfilerExport`, …) out of them. Missing
 * singletons are not reported here: `extract.ts > extractApiObjects` owns the
 * loud failure so every way a singleton can drop off fails through one path.
 */
export async function convertCuratedSingletons(
  sdkPath: string,
  sdkProject: ProjectReflection,
): Promise<{
  variables: DeclarationReflection[];
  projects: ProjectReflection[];
}> {
  const present = new Set(
    (
      sdkProject.getReflectionsByKind(
        ReflectionKind.Variable,
      ) as DeclarationReflection[]
    ).map((v) => v.name),
  );
  const pending = CURATED_SINGLETONS.filter((s) => !present.has(s.name));
  if (pending.length === 0) return { variables: [], projects: [] };

  // One conversion per owning package, even when several singletons share it.
  const byPackage = new Map<string, CuratedSingleton[]>();
  for (const singleton of pending) {
    const pkgDir = path.resolve(sdkPath, singleton.packageDir);
    const group = byPackage.get(pkgDir);
    if (group) group.push(singleton);
    else byPackage.set(pkgDir, [singleton]);
  }

  const variables: DeclarationReflection[] = [];
  const projects: ProjectReflection[] = [];

  for (const [pkgDir, singletons] of byPackage) {
    const tsconfigPath = path.join(pkgDir, "tsconfig.json").replace(/\\/g, "/");
    if (!existsSync(tsconfigPath)) continue;

    const app = await Application.bootstrapWithPlugins({
      // Deduplicated: several singletons may share one entry point, and a
      // repeated path makes TypeDoc fall back to directory expansion.
      entryPoints: [
        ...new Set(singletons.map((s) => resolveCuratedEntryPoint(sdkPath, s))),
      ],
      tsconfig: tsconfigPath,
      excludePrivate: true,
      excludeProtected: true,
      excludeExternals: true,
      skipErrorChecking: true,
      plugin: ["typedoc-plugin-zod"],
    });
    const project = await app.convert();
    if (!project) continue;
    projects.push(project);

    const wanted = new Set(singletons.map((s) => s.name));
    for (const decl of project.getReflectionsByKind(
      ReflectionKind.Variable,
    ) as DeclarationReflection[]) {
      if (wanted.has(decl.name)) variables.push(decl);
    }
  }

  return { variables, projects };
}
