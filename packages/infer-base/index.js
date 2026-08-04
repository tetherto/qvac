"use strict";
/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-require-imports -- Preserve the published untyped CommonJS compatibility surface. */
Object.defineProperty(exports, "__esModule", { value: true });
exports.getApiDefinition = exports.exclusiveRunQueue = exports.createJobHandler = exports.QvacResponse = void 0;
const QvacResponse = require("./src/QvacResponse");
exports.QvacResponse = QvacResponse;
const createJobHandlerImplementation = require("./src/utils/createJobHandler");
const exclusiveRunQueue = require("./src/utils/exclusiveRunQueue");
exports.exclusiveRunQueue = exclusiveRunQueue;
const getApiDefinition = require("./src/utils/getApiDefinition");
exports.getApiDefinition = getApiDefinition;
const createJobHandler = createJobHandlerImplementation;
exports.createJobHandler = createJobHandler;
// Replace TypeScript's intermediate exports object so require() retains the
// package's exact four-property CommonJS namespace and no default export.
module.exports = {
    QvacResponse,
    exclusiveRunQueue,
    getApiDefinition,
    createJobHandler
};
