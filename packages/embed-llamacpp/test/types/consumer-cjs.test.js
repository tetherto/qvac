"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.getRootDefaultImport = getRootDefaultImport;
exports.getDefaultImport = getDefaultImport;
exports.layaTypes = layaTypes;
const embed_llamacpp_1 = require("@qvac/embed-llamacpp");
const idMapIndex_1 = require("@qvac/embed-llamacpp/idMapIndex");
const rootConstructor = embed_llamacpp_1.default;
const sameConstructor = idMapIndex_1.default;
const filterConstructor = idMapIndex_1.default.IdMapIndexFilter;
void rootConstructor;
void sameConstructor;
void filterConstructor;
function getRootDefaultImport() {
    return embed_llamacpp_1.default;
}
function getDefaultImport() {
    return idMapIndex_1.default;
}
// Laya: config (with device) is required. run()'s per-shape result types are
// checked in consumer-interop.test.ts: in this CommonJS setup QvacResponse
// resolves to `any` (infer-base default-imports an `export =` module).
function layaTypes(model) {
    const laya = new embed_llamacpp_1.LayaDecisions({
        files: { model: [model] },
        config: { device: 'cpu', threads: '4' }
    });
    // @ts-expect-error config is required
    void new embed_llamacpp_1.LayaDecisions({ files: { model: [model] } });
    return laya;
}
