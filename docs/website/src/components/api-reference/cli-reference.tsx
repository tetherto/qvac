import { commandsOf, usage, type CliData, type CliOption } from '@/lib/api-reference/cli';
import { Code } from './code';

/**
 * The command reference of a command-line product, drawn from the line's
 * generated data.
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
          <Code code={usage(command)} lang="bash" />
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
