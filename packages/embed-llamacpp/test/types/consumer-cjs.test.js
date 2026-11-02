"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.pollingTypes = pollingTypes;
exports.layaTypes = layaTypes;
exports.rerankerTypes = rerankerTypes;
const embed_llamacpp_1 = require("@qvac/embed-llamacpp");
const rootConstructor = embed_llamacpp_1.default;
void rootConstructor;
function pollingTypes(model) {
    return new embed_llamacpp_1.default({
        files: { model: [model] },
        config: { device: 'gpu', poll: '0', 'poll-batch': '0' }
    });
}
// Laya: config (with device) is required. run()'s per-shape result types are
// checked in consumer-interop.test.ts: in this CommonJS setup QvacResponse
// resolves to `any` (infer-base default-imports an `export =` module).
function layaTypes(model) {
    const laya = new embed_llamacpp_1.LayaDecisions({
        files: { model: [model] },
        config: { device: 'cpu', threads: '4', poll: '0', 'poll-batch': '0' }
    });
    // @ts-expect-error config is required
    void new embed_llamacpp_1.LayaDecisions({ files: { model: [model] } });
    return laya;
}
// Reranker: config (with device) is required, and pooling is not an option.
function rerankerTypes(model) {
    const reranker = new embed_llamacpp_1.Reranker({
        files: { model: [model] },
        config: { device: 'gpu', gpu_layers: '99', batch_size: '512' }
    });
    // @ts-expect-error config is required
    void new embed_llamacpp_1.Reranker({ files: { model: [model] } });
    void new embed_llamacpp_1.Reranker({
        files: { model: [model] },
        // @ts-expect-error pooling is fixed to rank
        config: { device: 'cpu', pooling: 'rank' }
    });
    return reranker;
}
