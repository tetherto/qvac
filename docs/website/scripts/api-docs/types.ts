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

export interface ApiFunction {
  name: string;
  signature: string;
  description: string;
  parameters: Array<{
    name: string;
    type: string;
    required: boolean;
    description: string;
  }>;
  expandedParams: ExpandedType[];
  returns: { type: string; description: string };
  returnFields: TypeField[];
  expandedReturns: ExpandedType[];
  throws?: Array<{ error: string; description: string }>;
  examples?: string[];
  deprecated?: string;
}

export interface ErrorEntry {
  name: string;
  code: number;
  summary: string;
}

export interface GenerateOptions {
  updateLatest: boolean;
  devMode?: boolean;
}

export interface ApiData {
  version: string;
  generatedAt: string;
  functions: ApiFunction[];
  errors: {
    client: ErrorEntry[];
    server: ErrorEntry[];
  };
}
