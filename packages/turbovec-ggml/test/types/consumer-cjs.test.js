"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.getRootDefaultImport = getRootDefaultImport;
exports.getDefaultImport = getDefaultImport;
exports.checkAsyncTypes = checkAsyncTypes;
exports.checkSignalTypes = checkSignalTypes;
const turbovec_ggml_1 = require("@qvac/turbovec-ggml");
const idMapIndex_1 = require("@qvac/turbovec-ggml/idMapIndex");
const rootConstructor = turbovec_ggml_1.default;
const sameConstructor = idMapIndex_1.default;
const filterConstructor = idMapIndex_1.default.IdMapIndexFilter;
void rootConstructor;
void sameConstructor;
void filterConstructor;
function getRootDefaultImport() {
    return turbovec_ggml_1.default;
}
function getDefaultImport() {
    return idMapIndex_1.default;
}
class SubIdMapIndex extends idMapIndex_1.default {
}
// Compile-time checks of the declared types; never called.
async function checkAsyncTypes(index, query, ids) {
    const hits = await index.search(query, 1);
    const removed = await index.remove(1n);
    const present = await index.contains(1n);
    const filter = await index.prepareFilter(ids);
    const filtered = await filter.search(query, 1);
    const loaded = await SubIdMapIndex.load('index.tvim');
    const added = await index.addWithIds(query, ids);
    const built = await index.buildIvf(1);
    const length = index.length;
    const freed = await index.dispose();
    return { hits, removed, present, filtered, loaded, added, built, length, freed };
}
async function checkSignalTypes(index, query, signal) {
    const options = { signal };
    await index.search(query, 1, options);
    await index.buildIvf(4, 0, { signal });
    return idMapIndex_1.default.load('index.tvim', { signal });
}
