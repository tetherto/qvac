// ============== JSON Schema Types ==============

export type JsonSchemaType =
  | "string"
  | "number"
  | "integer"
  | "boolean"
  | "object"
  | "array"
  | "null";

export type JsonSchemaProperty = {
  type?: JsonSchemaType | JsonSchemaType[];
  description?: string;
  enum?: (string | number | boolean | null)[];
  items?: JsonSchema;
  properties?: Record<string, JsonSchemaProperty>;
  required?: string[];
  default?: unknown;
  additionalProperties?: boolean | JsonSchemaProperty;
};

export type JsonSchema = JsonSchemaProperty & {
  $schema?: string;
  title?: string;
};
