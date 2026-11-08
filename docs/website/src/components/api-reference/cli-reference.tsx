import { commandsOf, openApiOperations, usage, type CliData, type CliOption } from '@/lib/api-reference/cli';
import { ShapeTables } from './schema-table';

/**
 * The command reference of a command-line product and the operation
 * reference of its HTTP API, drawn from the line's generated data.
 */

function optionNotes(option: CliOption): string[] {
  const notes: string[] = [];
  if (option.required) notes.push('Required');
  if (option.default !== null && option.default !== undefined) notes.push(`Default: ${JSON.stringify(option.default)}`);
  if (option.choices) notes.push(`One of: ${option.choices.join(', ')}`);
  if (option.env) notes.push(`Env: ${option.env}`);
  return notes;
}

export function CliCommands({ data, path, tablesOnly }: { data: CliData; path?: string; tablesOnly?: boolean }) {
  // `tablesOnly` renders one command's usage and tables under a heading the
  // page writes itself, beside its own prose.
  const commands = tablesOnly && path ? commandsOf(data, path).filter((command) => command.path === path) : commandsOf(data, path);
  return (
    <div className="qv-cli-reference">
      {commands.map((command) => (
        <section key={command.path}>
          {!tablesOnly && (
            <h3 id={command.path.replace(/\s+/g, '-')}>
              <code>{command.path}</code>
            </h3>
          )}
          {!tablesOnly && command.description && <p>{command.description}</p>}
          <pre>
            <code>{usage(command)}</code>
          </pre>
          {command.arguments.length > 0 && (
            <table className="qv-schema-table">
              <thead>
                <tr>
                  <th>Argument</th>
                  <th>Required</th>
                  <th>Description</th>
                </tr>
              </thead>
              <tbody>
                {command.arguments.map((argument) => (
                  <tr key={argument.name}>
                    <td>
                      <code>{argument.name}</code>
                    </td>
                    <td>{argument.required ? 'Yes' : 'No'}</td>
                    <td>{argument.description}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          {command.options.length > 0 && (
            <table className="qv-schema-table">
              <thead>
                <tr>
                  <th>Option</th>
                  <th>Description</th>
                </tr>
              </thead>
              <tbody>
                {command.options.map((option) => (
                  <tr key={option.flags}>
                    <td>
                      <code>{option.flags}</code>
                    </td>
                    <td>
                      {option.description}
                      {optionNotes(option).length > 0 && (
                        <div className="qv-field-notes">{optionNotes(option).join(' · ')}</div>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </section>
      ))}
    </div>
  );
}

export function OpenApiOperations({ document }: { document: Record<string, unknown> }) {
  const { reader, operations } = openApiOperations(document);
  return (
    <div className="qv-openapi-reference">
      {operations.map((operation) => {
        const request = operation.request ? reader.shapeOf(operation.request) : null;
        return (
          <section key={`${operation.method} ${operation.path}`}>
            <h3 id={`${operation.method}-${operation.path}`.toLowerCase().replace(/[^a-z0-9]+/g, '-')}>
              <code>{`${operation.method} ${operation.path}`}</code>
            </h3>
            {operation.summary && <p>{operation.summary}</p>}
            {operation.description && operation.description !== operation.summary && <p>{operation.description}</p>}
            {request && (
              <details className="qv-field-children" open>
                <summary>Request body</summary>
                <ShapeTables shape={request} />
              </details>
            )}
            {operation.responses.length > 0 && (
              <p className="qv-field-notes">
                Responses:{' '}
                {operation.responses
                  .map((response) => `${response.status}${response.description ? ` ${response.description}` : ''}`)
                  .join(' · ')}
              </p>
            )}
          </section>
        );
      })}
    </div>
  );
}
