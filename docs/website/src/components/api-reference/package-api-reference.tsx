import { Fragment } from 'react';
import {
  EXPORT_GROUPS,
  exportAnchor,
  type PackageApi,
  type PackageApiExport,
  type PackageApiField,
  type PackageApiSignature,
} from '@/lib/api-reference/package-api';

/**
 * A package's API reference: every public export, grouped by kind, each with
 * its signatures, fields, or values as the normalizer wrote them.
 */

function Fields({ fields, label }: { fields: PackageApiField[]; label: string }) {
  return (
    <table className="qv-schema-table">
      <thead>
        <tr>
          <th>{label}</th>
          <th>Type</th>
          <th>Description</th>
        </tr>
      </thead>
      <tbody>
        {fields.map((field) => (
          <tr key={field.name}>
            <td>
              <code>{`${field.name}${field.optional ? '?' : ''}`}</code>
            </td>
            <td>
              <code>{field.type}</code>
            </td>
            <td>{field.description || '—'}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function Signature({ signature }: { signature: PackageApiSignature }) {
  return (
    <>
      <pre>
        <code>{signature.text}</code>
      </pre>
      {signature.parameters.length > 0 && <Fields fields={signature.parameters} label="Parameter" />}
      {signature.returns.description && (
        <p>
          Returns <code>{signature.returns.type}</code>: {signature.returns.description}
        </p>
      )}
    </>
  );
}

function Export({ entry }: { entry: PackageApiExport }) {
  return (
    <section className="qv-package-export">
      <h3 id={exportAnchor(entry.name)}>
        <code>{entry.name}</code>
      </h3>
      {entry.deprecated && (
        <p>
          <strong>Deprecated:</strong> {entry.deprecated}
        </p>
      )}
      {entry.summary && <p>{entry.summary}</p>}
      {entry.signatures?.map((signature) => (
        <Signature key={signature.text} signature={signature} />
      ))}
      {entry.fields && entry.fields.length > 0 && <Fields fields={entry.fields} label="Field" />}
      {entry.methods?.map((method) => (
        <Fragment key={method.name}>
          <h4>
            <code>{`${method.name}()`}</code>
          </h4>
          {method.signatures.map((signature) => (
            <Signature key={signature.text} signature={signature} />
          ))}
        </Fragment>
      ))}
      {entry.values && entry.values.length > 0 && (
        <ul>
          {entry.values.map((value) => (
            <li key={value}>
              <code>{value}</code>
            </li>
          ))}
        </ul>
      )}
      {entry.type && (
        <pre>
          <code>{`type ${entry.name} = ${entry.type}`}</code>
        </pre>
      )}
    </section>
  );
}

export function PackageApiExports({ api }: { api: PackageApi }) {
  return (
    <div className="qv-package-api">
      {EXPORT_GROUPS.map(([kind, heading]) => {
        const entries = api.exports.filter((entry) => entry.kind === kind);
        if (entries.length === 0) return null;
        return (
          <Fragment key={kind}>
            <h2 id={exportAnchor(heading)}>{heading}</h2>
            {entries.map((entry) => (
              <Export key={entry.name} entry={entry} />
            ))}
          </Fragment>
        );
      })}
    </div>
  );
}
