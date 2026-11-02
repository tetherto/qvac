/** Names of the entries that carry a value, for "wrong engine" messages. */
export declare function setOptionNames(options: Record<string, string | number | boolean | undefined>): string[];
/** Which of `keys` are set on `source`. Used to name stray options in errors. */
export declare function keysPresent(source: object | null | undefined, keys: readonly string[]): string[];
