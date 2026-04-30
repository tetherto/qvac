export interface TypeField {
  name: string;
  type: string;
  required: boolean;
  defaultValue?: string;
  description: string;
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
  | { kind: "reference"; name: string }
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
   * One-line summary, used by object-method bullet lists. The single-page
   * renderer uses the first sentence of `description` when this is omitted.
   */
  summary?: string;
  /**
   * Optional narrative paragraph rendered between the function description
   * and the signature block. Sourced from sample MDX lead paragraphs (and
   * potentially from JSDoc body prose in the future).
   */
  leadParagraph?: string;
  parameters: Array<{
    name: string;
    type: string;
    required: boolean;
    defaultValue?: string;
    description: string;
    /** Machine-readable type breakdown. */
    typeStructure?: StructuredType;
  }>;
  expandedParams: ExpandedType[];
  returns: {
    type: string;
    description: string;
    typeStructure?: StructuredType;
  };
  returnFields: TypeField[];
  expandedReturns: ExpandedType[];
  throws?: Array<{ error: string; description: string }>;
  examples?: string[];
  examplesSource?: ContentSource;
  deprecated?: string;
  /**
   * When the function declares multiple overloads, this is a per-overload
   * breakdown produced by the extractor (one entry per unique signature).
   * The single-page renderer emits one `#### Overload N` block per entry.
   * Absent or empty for single-signature functions.
   */
  overloads?: ApiOverload[];
}

export interface ApiOverload {
  signature: string;
  description?: string;
  throws?: Array<{ error: string; description: string }>;
  examples?: string[];
  deprecated?: string;
  /** Optional human-friendly label, e.g. "Single text" or "Run / start". */
  label?: string;
}

export interface ApiObject {
  name: string;
  description: string;
  descriptionSource?: ContentSource;
  /** One-line summary, used by per-object bullet lists. */
  summary?: string;
  /**
   * Optional narrative paragraph rendered between the object description
   * and the shape block.
   */
  leadParagraph?: string;
  /**
   * Pre-formatted TypeScript declaration of the object shape, e.g.
   * `const profiler: { enable(...): void; ... };`. Rendered as a `ts`
   * code block under `**Shape**:` in the single-page renderer.
   */
  objectSignature?: string;
  fields: TypeField[];
  children: ExpandedType[];
  /**
   * Per-method `ApiFunction` records. The single-page renderer emits one
   * bullet per method (`name(args?) — first-sentence summary`); the
   * function-level fields (signature, throws, examples) are not surfaced
   * for object methods — readers go to the IDE for those details.
   */
  methods?: ApiFunction[];
  examples?: string[];
  examplesSource?: ContentSource;
}

export interface ErrorEntry {
  name: string;
  code: number;
  summary: string;
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
