"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.getRootDefaultImport = getRootDefaultImport;
exports.getDefaultImport = getDefaultImport;
const __1 = require("../..");
const idMapIndex_1 = require("../../idMapIndex");
const rootConstructor = __1.default;
const sameConstructor = idMapIndex_1.default;
const filterConstructor = idMapIndex_1.default.IdMapIndexFilter;
void rootConstructor;
void sameConstructor;
void filterConstructor;
function getRootDefaultImport() {
    return __1.default;
}
function getDefaultImport() {
    return idMapIndex_1.default;
}
