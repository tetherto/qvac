import type { ReactNode } from 'react';
import { formatSize, modelsForEngines } from '@/lib/api-reference/card';
import { openApiOperations, type CliData } from '@/lib/api-reference/cli';
import { functionNames, functionReference, lineApiForUrl, lineGeneratedFile, type LineApi } from '@/lib/api-reference/data';
import type { PackageApi } from '@/lib/api-reference/package-api';
import { CliCommands } from './cli-reference';
import { Code } from './code';
import { OpenAPIPage } from './openapi-page';
import { PackageApiExports } from './package-api-reference';
import { LanguageSwitch } from './language-switch';
import { ShapeTables } from './schema-table';

/**
 * The data components of one page, bound to the page's documentation line.
 * Each reads the API data of that line's snapshot, so an older line renders
 * its own API. On a line without API data — one still held in place — they
 * render a notice instead of facts they do not have.
 */

function Missing({ children }: { children: ReactNode }) {
  return <p className="qv-api-missing">{children}</p>;
}

export function apiComponentsFor(url: string) {
  const api: LineApi | null = lineApiForUrl(url);

  function SchemaTable({ fn }: { fn: string }) {
    if (!api) return <Missing>API data is not available for this documentation line.</Missing>;
    const reference = functionReference(api, fn);
    if (!reference?.request) return <Missing>{`No contract fields are published for \`${fn}\`.`}</Missing>;
    return (
      <div className="qv-schema">
        <LanguageSwitch />
        <ShapeTables shape={reference.request} />
      </div>
    );
  }

  function ModelsTable({ engines }: { engines: string[] }) {
    if (!api) return <Missing>API data is not available for this documentation line.</Missing>;
    const models = modelsForEngines(api, engines);
    if (models.length === 0) return <Missing>No model constant is registered for this capability.</Missing>;
    const table = (
      <table className="qv-models-table">
        <thead>
          <tr>
            <th>Constant</th>
            <th>Engine</th>
            <th>Quantization</th>
            <th>Size</th>
          </tr>
        </thead>
        <tbody>
          {models.map((model) => (
            <tr key={model.name}>
              <td>
                <code>{model.name}</code>
              </td>
              <td>{model.engine}</td>
              <td>{model.quantization ?? '—'}</td>
              <td>{formatSize(model.expectedSize) ?? '—'}</td>
            </tr>
          ))}
        </tbody>
      </table>
    );
    // A long registry list stays folded, so the page's prose stays in view.
    if (models.length <= 12) return table;
    return (
      <details className="qv-models-list">
        <summary>{`${models.length} model constants`}</summary>
        {table}
      </details>
    );
  }

  function FunctionReference({ fn }: { fn: string }) {
    if (!api) return <Missing>API data is not available for this documentation line.</Missing>;
    const reference = functionReference(api, fn);
    if (!reference) return <Missing>{`\`${fn}\` is not a public function of this line.`}</Missing>;
    return (
      <div className="qv-function-reference">
        {reference.deprecated && (
          <p>
            <strong>Deprecated:</strong> {reference.deprecated}
          </p>
        )}
        {reference.description
          .split(/\n\s*\n/)
          .map((paragraph) => paragraph.trim())
          .filter(Boolean)
          .map((paragraph) => (
            <p key={paragraph}>{paragraph}</p>
          ))}
        <h2 id="signature">Signature</h2>
        <Code code={reference.jsSignature} lang="ts" />
        {reference.pythonSignature && <Code code={reference.pythonSignature} lang="python" />}
        {reference.request && (
          <>
            <h2 id="parameters">Parameters</h2>
            <LanguageSwitch />
            <ShapeTables shape={reference.request} />
          </>
        )}
        {reference.returnFields.length > 0 && (
          <>
            <h2 id="returns">Returns</h2>
            <table className="qv-schema-table">
              <thead>
                <tr>
                  <th>Field</th>
                  <th>Type</th>
                </tr>
              </thead>
              <tbody>
                {reference.returnFields.map((field) => (
                  <tr key={field.name}>
                    <td>
                      <code>{field.name}</code>
                    </td>
                    <td>
                      <code>{field.type}</code>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </>
        )}
        {reference.throws.length > 0 && (
          <>
            <h2 id="throws">Throws</h2>
            <ul>
              {reference.throws.map((entry) => (
                <li key={entry.error}>
                  <code>{entry.error}</code>: {entry.description}
                </li>
              ))}
            </ul>
          </>
        )}
        {reference.target && (
          <p>
            Request and response schema: <a href={`${api.base}/reference/api/${fn}.schema.json`}>{`${fn}.schema.json`}</a>
          </p>
        )}
      </div>
    );
  }

  function FunctionIndex() {
    if (!api) return <Missing>API data is not available for this documentation line.</Missing>;
    return (
      <ul className="qv-function-index">
        {functionNames(api).map((name) => (
          <li key={name}>
            <a href={`${api.base}/reference/api/${name}/`}>
              <code>{name}</code>
            </a>
          </li>
        ))}
      </ul>
    );
  }

  function CliReference({ command, tablesOnly }: { command?: string; tablesOnly?: boolean }) {
    const data = lineGeneratedFile<CliData>(url, 'cli.json');
    if (!data) return <Missing>Command reference data is not available for this documentation line.</Missing>;
    return <CliCommands data={data} path={command} tablesOnly={tablesOnly} />;
  }

  function OpenApiReference() {
    const document = lineGeneratedFile<Record<string, unknown>>(url, 'openapi.json');
    if (!document) return <Missing>HTTP API reference data is not available for this documentation line.</Missing>;
    return (
      <OpenAPIPage
        document="openapi"
        payload={{ bundled: document as never }}
        operations={openApiOperations(document).operations.map((operation) => ({
          path: operation.path,
          method: operation.method.toLowerCase() as never,
        }))}
        showTitle
        showDescription
      />
    );
  }

  function PackageApiReference() {
    const data = lineGeneratedFile<PackageApi>(url, 'api.json');
    if (!data) return <Missing>API reference data is not available for this documentation line.</Missing>;
    return <PackageApiExports api={data} />;
  }

  return { SchemaTable, ModelsTable, FunctionReference, FunctionIndex, LanguageSwitch, CliReference, OpenApiReference, PackageApiReference };
}
