"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.getRootDefaultImport = getRootDefaultImport;
exports.getDefaultImport = getDefaultImport;
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
