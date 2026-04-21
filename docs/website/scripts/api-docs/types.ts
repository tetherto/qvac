export interface TypeField {
  name: string;
  type: string;
  required: boolean;
  defaultValue?: string;
  description: string;
}

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
  parameters: Array<{
    name: string;
    type: string;
    required: boolean;
    defaultValue?: string;
    description: string;
  }>;
  expandedParams: ExpandedType[];
  returns: { type: string; description: string };
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
  members?: Array<{ name: string; description: string }>;
}

export interface ErrorEntry {
  name: string;
  code: number;
  summary: string;
}

export interface GenerateOptions {
  updateLatest: boolean;
  devMode?: boolean;
  forceExtract?: boolean;
  noAi?: boolean;
}

export interface ApiData {
  version: string;
  generatedAt: string;
  functions: ApiFunction[];
  objects?: ApiObject[];
  types?: ApiType[];
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
