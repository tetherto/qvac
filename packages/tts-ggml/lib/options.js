"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.setOptionNames = setOptionNames;
exports.keysPresent = keysPresent;
/** Names of the entries that carry a value, for "wrong engine" messages. */
function setOptionNames(options) {
    return Object.entries(options)
        .filter(([, value]) => value != null)
        .map(([name]) => name);
}
/** Which of `keys` are set on `source`. Used to name stray options in errors. */
function keysPresent(source, keys) {
    if (source == null || typeof source !== "object")
        return [];
    const record = source;
    return keys.filter((key) => record[key] != null && record[key] !== "");
}
