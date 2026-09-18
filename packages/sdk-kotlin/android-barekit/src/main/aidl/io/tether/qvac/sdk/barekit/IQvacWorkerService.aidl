package io.tether.qvac.sdk.barekit;

import io.tether.qvac.sdk.barekit.IQvacWorkerCallback;

interface IQvacWorkerService {
    void call(String payload, IQvacWorkerCallback callback);
    void stream(String payload, IQvacWorkerCallback callback);
    void duplex(String requestId, String payload, IQvacWorkerCallback callback);
    void duplexChunk(String requestId, in byte[] chunk, boolean endOfInput);
    void close();
    void cancelDuplex(String requestId);
}
