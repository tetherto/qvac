"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.getRootDefaultImport = getRootDefaultImport;
exports.getDefaultImport = getDefaultImport;
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
