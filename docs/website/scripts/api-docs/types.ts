export interface TypeField {
  name: string;
  type: string;
  required: boolean;
  defaultValue?: string;
  description: string;
  /**
   * JSON-pointer-style cross-reference to a canonical `ApiType` in the same
   * document, e.g. `"#/types/CompletionParams"`. Populated when the field's
   * type is a named alias that exists in `ApiData.types[]`. Allows machine
   * consumers to follow the reference rather than parse the `type` string.
   */
  typeRef?: string;
  /**
   * Machine-readable breakdown of `type`. Lets consumers distinguish
   * arrays, unions, references, and primitives without parsing the string
   * form. Omitted for string-only fields.
   */
  typeStructure?: StructuredType;
}

/**
 * Structured type descriptor. Discriminated by `kind`. Exists alongside the
 * human-readable `type` string on every field; machine consumers should
 * prefer this form.
 */
export type StructuredType =
  | { kind: "primitive"; name: string }
  | { kind: "literal"; value: string | number | boolean | null }
  | { kind: "reference"; name: string; typeRef?: string }
  | { kind: "array"; element: StructuredType }
  | { kind: "union"; variants: StructuredType[] }
  | { kind: "intersection"; parts: StructuredType[] }
  | { kind: "object" }
  | { kind: "function" }
  | { kind: "unknown" };

export interface ExpandedType {
  typeName: string;
  fields: TypeField[];
  children: ExpandedType[];
}

export type ContentSource = "extracted" | "ai";

export interface ApiFunction {
  name: string;
  signature: string;
  description: string;
  descriptionSource?: ContentSource;
  /**
   * One-line summary used in the index page's Functions table. When omitted,
   * the renderer falls back to the first sentence of `description`. The
   * hand-written samples curate this separately from the function-page
   * description.
   */
  summary?: string;
  /**
   * Optional narrative paragraph rendered between the signature block and the
   * first `## Parameters` / `## Returns` heading. Sourced either from JSDoc
   * body prose (future) or from a sample MDX's lead paragraph.
   */
  leadParagraph?: string;
  parameters: Array<{
    name: string;
    type: string;
    required: boolean;
    defaultValue?: string;
    description: string;
    /** JSON-pointer ref to `ApiData.types[name]` when type is a named alias. */
    typeRef?: string;
    /** Machine-readable type breakdown. */
    typeStructure?: StructuredType;
  }>;
  expandedParams: ExpandedType[];
  returns: {
    type: string;
    description: string;
    typeRef?: string;
    typeStructure?: StructuredType;
  };
  returnFields: TypeField[];
  expandedReturns: ExpandedType[];
  throws?: Array<{ error: string; description: string }>;
  examples?: string[];
  examplesSource?: ContentSource;
  deprecated?: string;
}

export interface ApiObject {
  name: string;
  description: string;
  descriptionSource?: ContentSource;
  /** One-line summary used in the index page's Object table. */
  summary?: string;
  /**
   * Optional narrative paragraph rendered between the object signature block
   * and the first `## Methods` / `## Fields` heading.
   */
  leadParagraph?: string;
  /**
   * Optional pre-formatted TypeScript declaration of the object shape
   * (e.g., `const profiler: { enable(...): void; ... };`). When present,
   * rendered as a `<WrapCode>` block at the top of the page.
   */
  objectSignature?: string;
  fields: TypeField[];
  children: ExpandedType[];
  /**
   * When non-empty, the object is rendered as a "namespace" page with a
   * `## Methods` index table and one `### name()` subsection per method,
   * mirroring the per-function layout. The flat `fields` table is omitted
   * in this mode.
   */
  methods?: ApiFunction[];
  examples?: string[];
  examplesSource?: ContentSource;
}

export interface ApiType {
  name: string;
  description: string;
  definition: string;
  /**
   * Flat member list. For interfaces / object aliases these are the type's
   * fields (rendered as a `Field | Type | Required? | Default | Description`
   * table matching the sample). For union aliases these are literal member
   * names. When empty the type is rendered as a code-block alias only.
   */
  fields?: TypeField[];
  /**
   * Legacy simplified member list used by the old template. Kept for
   * backward compatibility with test snapshots and ai-augment; new rendering
   * should prefer `fields`.
   *
   * @deprecated prefer `fields`
   */
  members?: Array<{ name: string; description: string }>;
  /** Nested expanded types referenced by this type (rendered as `### NestedType`). */
  children?: ExpandedType[];
}

export interface ErrorEntry {
  name: string;
  code: number;
  summary: string;
  /**
   * Rendered list of `functionName()` calls that throw this error, joined
   * with commas (e.g., "`loadModel()`, `completion()`"). Populated by the
   * renderer from each ApiFunction's `throws` array. Literal "Internal RPC
   * layer" / "Any API call" overrides come from the sample's curated labels
   * and are preserved when no public function references the error.
   */
  thrownBy?: string;
}

/**
 * Non-function, non-method-bundle exported value constant — captures SDK
 * exports like `SDK_DEFAULT_PLUGINS`, `PLUGIN_LLM`, `MODEL_TYPES`,
 * `VERBOSITY`, `SUPPORTED_AUDIO_FORMATS`, `SDK_LOG_ID`, `models`.
 * Rendered as rows on a single `constants.mdx` reference page.
 */
export interface ApiConstant {
  name: string;
  /** TypeScript type string, e.g. `"cpu" | "gpu"` or `readonly string[]`. */
  type: string;
  /**
   * Literal value when the constant is a simple primitive or a short `as
   * const` object / array. Omitted when the value is too large to inline
   * (registries, long arrays).
   */
  value?: string;
  description: string;
  descriptionSource?: ContentSource;
}

export interface GenerateOptions {
  updateLatest: boolean;
  devMode?: boolean;
  forceExtract?: boolean;
  noAi?: boolean;
}

export interface ApiData {
  /**
   * Relative pointer to the JSON Schema describing this document. Allows
   * editors and downstream tools to validate/autocomplete the file.
   */
  $schema?: string;
  version: string;
  generatedAt: string;
  functions: ApiFunction[];
  objects?: ApiObject[];
  types?: ApiType[];
  /**
   * Value-export constants (plugin IDs, enum-like const objects, registry
   * lists, log identifiers). Separate from `objects` which are reserved for
   * method-bundle singletons like `profiler`.
   */
  constants?: ApiConstant[];
  errors: {
    client: ErrorEntry[];
    server: ErrorEntry[];
  };
}

export interface AuditDiagnostic {
  functionName: string;
  missingParams: string[];
  missingReturns: boolean;
  missingThrows: boolean;
  bodyHasThrow: boolean;
}

export interface AuditOptions {
  strict?: boolean;
  quiet?: boolean;
}

export interface AuditResult {
  diagnostics: AuditDiagnostic[];
  total: number;
  complete: number;
  completenessPercent: number;
}
