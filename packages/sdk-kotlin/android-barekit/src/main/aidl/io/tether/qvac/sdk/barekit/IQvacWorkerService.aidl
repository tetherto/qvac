package io.tether.qvac.sdk.barekit;

import io.tether.qvac.sdk.barekit.IQvacWorkerCallback;

interface IQvacWorkerService {
    void call(String payload, IQvacWorkerCallback callback);
    void stream(String payload, IQvacWorkerCallback callback);
    void duplex(String requestId, String payload, IQvacWorkerCallback callback);
    void duplexChunk(String requestId, in byte[] chunk, boolean endOfInput);
    void requestChunk(String requestId, String chunk, boolean endOfRequest);
    void callAssembled(String requestId, IQvacWorkerCallback callback);
    void streamAssembled(String requestId, IQvacWorkerCallback callback);
    void duplexAssembled(String requestId, IQvacWorkerCallback callback);
    void close();
    void cancelDuplex(String requestId);
}
