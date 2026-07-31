// The IndicTrans pre/post-processor ships as untyped runtime JavaScript under
// `third-party/`. Declare a narrow surface so the TypeScript wrapper can keep
// requiring it without pulling the vendored sources into the build.
declare module "*/indic-processor" {
  export class IndicProcessor {
    preprocessBatch(texts: string[], srcLang: string, dstLang: string): string[];
    postprocessBatch(texts: string[], dstLang: string): string[];
  }
}
