"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.getRootDefaultImport = getRootDefaultImport;
exports.getDefaultImport = getDefaultImport;
exports.checkAsyncTypes = checkAsyncTypes;
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
// Compile-time checks of the async API's declared types; never called.
async function checkAsyncTypes(index, query, ids) {
    const hits = await index.searchAsync(query, 1);
    const removed = await index.removeAsync(1n);
    const filter = await index.prepareFilterAsync(ids);
    const filtered = await filter.searchAsync(query, 1);
    const loaded = await SubIdMapIndex.loadAsync('index.tvim');
    const added = await index.addWithIdsAsync(query, ids);
    const built = await index.buildIvfAsync(1);
    await index.disposeAsync();
    return { hits, removed, filtered, loaded, added, built };
}
