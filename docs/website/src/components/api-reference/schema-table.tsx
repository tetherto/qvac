import type { Field, Shape } from '@/lib/api-reference/schema';
import { toSnakeCase } from '@/lib/api-reference/names';

/**
 * A shape as nested field tables: one row per field, with its type, whether
 * it is required, its default and constraints, and its description. A field
 * holding an object, or a union of objects, expands in place. Each field name
 * is written in both SDK languages; the language switch shows one.
 */

function FieldName({ name }: { name: string }) {
  const python = toSnakeCase(name);
  if (python === name) return <code>{name}</code>;
  return (
    <code>
      <span data-sdk-language-name="js">{name}</span>
      <span data-sdk-language-name="python">{python}</span>
    </code>
  );
}

const MAX_INLINE_VALUES = 8;

function FieldType({ field }: { field: Field }) {
  if (field.values && field.values.length > MAX_INLINE_VALUES) {
    return (
      <details>
        <summary>
          one of {field.values.length} values
        </summary>
        <code>{field.values.join(' | ')}</code>
      </details>
    );
  }
  return <code>{field.type}</code>;
}

function FieldRow({ field }: { field: Field }) {
  const notes = [...field.constraints, ...(field.default !== undefined ? [`Default: ${field.default}`] : [])];
  return (
    <tr>
      <td>
        <FieldName name={field.name} />
      </td>
      <td>
        <FieldType field={field} />
      </td>
      <td>{field.required ? 'Yes' : 'No'}</td>
      <td>
        {field.description}
        {notes.length > 0 && <div className="qv-field-notes">{notes.join(' · ')}</div>}
        {field.shape && (
          <details className="qv-field-children">
            <summary>Fields</summary>
            <ShapeTables shape={field.shape} />
          </details>
        )}
      </td>
    </tr>
  );
}

function FieldTable({ fields }: { fields: Field[] }) {
  if (fields.length === 0) return <p>No fields.</p>;
  return (
    <table className="qv-schema-table">
      <thead>
        <tr>
          <th>Field</th>
          <th>Type</th>
          <th>Required</th>
          <th>Description</th>
        </tr>
      </thead>
      <tbody>
        {fields.map((field) => (
          <FieldRow key={field.name} field={field} />
        ))}
      </tbody>
    </table>
  );
}

export function ShapeTables({ shape }: { shape: Shape }) {
  if (shape.kind === 'object') return <FieldTable fields={shape.fields} />;
  return (
    <div className="qv-schema-variants">
      <p>One of {shape.variants.length} forms:</p>
      {shape.variants.map((variant) => (
        <details key={variant.label} className="qv-schema-variant" open={shape.variants.length <= 3}>
          <summary>{variant.label}</summary>
          <FieldTable fields={variant.shape.fields} />
        </details>
      ))}
    </div>
  );
}
